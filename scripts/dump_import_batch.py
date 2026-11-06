#!/usr/bin/env python3
"""
Phoenix Mesh — Importeur par lots du dump HTML Wikipédia Enterprise v3
- Envoi par lots de 25 éléments par requête pour accélérer le traitement
- Traitement en flux (moins d'environ 100 Mo de mémoire)
- Reconnexion automatique en cas de coupure (10 fois au maximum)
"""

import urllib.request
import tarfile
import json
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Configuration ──────────────────────────────────────────────────────────────────────
DUMP_URL      = "https://dumps.wikimedia.org/other/enterprise_html/runs/20250320/jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz"
SUBMIT_URL    = "https://wikipedia-is-dead.com/api/contribute/submit"
BATCH_URL     = "https://wikipedia-is-dead.com/api/contribute/submit-batch"
EXISTING      = "/tmp/existing_titles.txt"
DONE_FILE     = "/tmp/phoenix_done_this_run.txt"
WORKERS       = 16       # Nombre de lots en parallèle
BATCH_SIZE    = 25       # Nombre d'articles par requête
LOG_EVERY     = 500
RETRY_UP      = 3
MAX_RECONN    = 10

# ── Statistiques ──────────────────────────────────────────────────────────────────────
_lock     = threading.Lock()
_uploaded = 0
_skipped  = 0
_failed   = 0
_t0       = time.time()

def _inc(key, n=1):
    global _uploaded, _skipped, _failed
    with _lock:
        if   key == "up": _uploaded += n
        elif key == "sk": _skipped  += n
        elif key == "fa": _failed   += n

def _progress(force=False):
    total = _uploaded + _skipped + _failed
    if not force and total % LOG_EVERY != 0:
        return
    elapsed = time.time() - _t0
    rate    = _uploaded / elapsed if elapsed > 1 else 0
    remain  = max(0, 1_350_000 - _uploaded)
    eta_h   = (remain / rate / 3600) if rate > 0 else 0
    pct     = min(_uploaded / 1_350_000, 1.0)
    bar_w   = 30
    bar     = "█" * int(bar_w * pct) + "░" * (bar_w - int(bar_w * pct))
    print(
        f"\r[{bar}] {_uploaded:>8,}élém. envoyés | skip:{_skipped:,} fail:{_failed:,} | "
        f"{rate:.0f} élém./s | ETA:{eta_h:.1f}h",
        end="", flush=True
    )

# ── Lecture des titres existants ───────────────────────────────────────────────────────
def load_existing():
    titles = set()
    for path in (EXISTING, DONE_FILE):
        try:
            with open(path) as f:
                before = len(titles)
                titles.update(l.strip() for l in f if l.strip())
                print(f"  {path}: {len(titles)-before:,} titres")
        except FileNotFoundError:
            pass
    print(f"  → Total à ignorer : {len(titles):,} titres\n")
    return titles

# ── Envoi par lots ─────────────────────────────────────────────────────────
def upload_batch(articles):
    """articles: list of {"title": str, "html": str}"""
    data = json.dumps({"articles": articles}).encode()
    for attempt in range(RETRY_UP):
        try:
            req = urllib.request.Request(
                BATCH_URL, data=data,
                headers={"Content-Type": "application/json",
                         "User-Agent": "PhoenixMesh-DumpImport/3.0"}
            )
            with urllib.request.urlopen(req, timeout=120) as r:
                if r.status == 200:
                    resp = json.loads(r.read())
                    return resp.get("processed", len(articles))
        except Exception:
            if attempt < RETRY_UP - 1:
                time.sleep(1.5 ** attempt)
    return 0

def upload_single(title, html):
    data = json.dumps({"title": title, "html": html}).encode()
    for attempt in range(RETRY_UP):
        try:
            req = urllib.request.Request(
                SUBMIT_URL, data=data,
                headers={"Content-Type": "application/json",
                         "User-Agent": "PhoenixMesh-DumpImport/3.0"}
            )
            with urllib.request.urlopen(req, timeout=45) as r:
                if r.status == 200:
                    return True
        except Exception:
            if attempt < RETRY_UP - 1:
                time.sleep(1.5 ** attempt)
    return False

# ── Traitement par lots ─────────────────────────────────────────────────────────────────
def process_batch(articles, done_fh):
    """articles: list of (title, html) tuples from the stream"""
    payload = [{"title": t, "html": h} for t, h in articles]
    processed = upload_batch(payload)
    if processed > 0:
        with _lock:
            for title, _ in articles[:processed]:
                done_fh.write(title + "\n")
        done_fh.flush()
        _inc("up", processed)
        if processed < len(articles):
            _inc("fa", len(articles) - processed)
    else:
        # Repli : envoi individuel
        for title, html in articles:
            if upload_single(title, html):
                with _lock:
                    done_fh.write(title + "\n")
                done_fh.flush()
                _inc("up")
            else:
                _inc("fa")
    return processed

# ── Traitement en flux (un passage) ────────────────────────────────────────────────────
def stream_once(existing, done_fh):
    req = urllib.request.Request(
        DUMP_URL,
        headers={"User-Agent": "PhoenixMesh-DumpImport/3.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        with tarfile.open(fileobj=resp, mode="r|gz") as tar:
            for member in tar:
                fobj = tar.extractfile(member)
                if not fobj:
                    continue
                size_mb = member.size / 1024 / 1024
                print(f"\nFichier interne : {member.name}  ({size_mb:,.0f} Mo après décompression)")

                with ThreadPoolExecutor(max_workers=WORKERS) as ex:
                    futures = {}
                    pending = []   # Accumule les paires (title, html)

                    def flush_pending(buf):
                        for i in range(0, len(buf), BATCH_SIZE):
                            chunk = buf[i:i+BATCH_SIZE]
                            fut = ex.submit(process_batch, chunk, done_fh)
                            futures[fut] = len(chunk)

                    def collect():
                        done = [f for f in list(futures) if f.done()]
                        for f in done:
                            del futures[f]
                        _progress()

                    for raw in fobj:
                        try:
                            line = raw.decode("utf-8", errors="replace").strip()
                        except Exception:
                            continue
                        if not line:
                            continue
                        try:
                            obj   = json.loads(line)
                            title = obj.get("name", "").strip()
                            html  = obj.get("article_body", {}).get("html", "")
                            if not title or len(html) < 500:
                                _inc("sk")
                                continue
                            if title in existing:
                                _inc("sk")
                                continue
                            pending.append((title, html))
                        except Exception:
                            _inc("fa")
                            continue

                        if len(pending) >= BATCH_SIZE * WORKERS * 2:
                            flush_pending(pending)
                            pending = []
                        if len(futures) >= WORKERS * 4:
                            collect()

                    if pending:
                        flush_pending(pending)
                    for f in as_completed(list(futures)):
                        _progress()

    return True

# ── Programme principal ────────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print(" Phoenix Mesh — Wikipedia Dump Importer v3 (Batch)")
    print("=" * 60)
    print(f"  Destination : {BATCH_URL}")
    print(f"  Parallélisme : {WORKERS} threads × {BATCH_SIZE} éléments/lot\n")

    existing = load_existing()
    done_fh  = open(DONE_FILE, "a", buffering=1)

    for attempt in range(1, MAX_RECONN + 1):
        if attempt > 1:
            wait = min(30 * attempt, 180)
            print(f"\nReconnexion {attempt}/{MAX_RECONN}... attente de {wait} s")
            time.sleep(wait)
            existing = load_existing()

        print(f"Début du téléchargement en flux (essai {attempt}/{MAX_RECONN})")
        try:
            stream_once(existing, done_fh)
            print("\nTous les fichiers ont été traités normalement !")
            break
        except KeyboardInterrupt:
            print("\nInterrompu.")
            break
        except tarfile.ReadError as e:
            print(f"\nCoupure : {e} → reconnexion automatique")
        except Exception as e:
            print(f"\nErreur : {e} → reconnexion automatique")

    done_fh.close()
    _progress(force=True)
    elapsed = time.time() - _t0
    print(f"""

{'=' * 60}
 Rapport final
{'=' * 60}
  Envoyés     : {_uploaded:,}
  Ignorés     : {_skipped:,} (déjà présents ou vides)
  Échecs      : {_failed:,}
  Durée       : {elapsed/3600:.2f} h
  Débit moyen : {_uploaded/elapsed:.0f} élém./s
{'=' * 60}
""")

if __name__ == "__main__":
    main()
