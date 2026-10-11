#!/usr/bin/env python3
"""
Phoenix Mesh — Wikipedia Enterprise HTML Dump バッチインポーター v3
- 25件/リクエストのバッチ送信で高速化
- ストリーム処理（メモリ ~100MB以下）
- 切断時自動再接続（最大10回）
"""

import urllib.request
import tarfile
import json
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── 設定 ──────────────────────────────────────────────────────────────────────
DUMP_URL      = "https://dumps.wikimedia.org/other/enterprise_html/runs/20250320/jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz"
SUBMIT_URL    = "https://wikipedia-is-dead.com/api/contribute/submit"
BATCH_URL     = "https://wikipedia-is-dead.com/api/contribute/submit-batch"
EXISTING      = "/tmp/existing_titles.txt"
DONE_FILE     = "/tmp/phoenix_done_this_run.txt"
WORKERS       = 16       # 並列バッチ数
BATCH_SIZE    = 25       # 1リクエストあたりの記事数
LOG_EVERY     = 500
RETRY_UP      = 3
MAX_RECONN    = 10

# ── 統計 ──────────────────────────────────────────────────────────────────────
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
        f"\r[{bar}] {_uploaded:>8,}件UP | skip:{_skipped:,} fail:{_failed:,} | "
        f"{rate:.0f}件/s | ETA:{eta_h:.1f}h",
        end="", flush=True
    )

# ── 既存タイトル読み込み ───────────────────────────────────────────────────────
def load_existing():
    titles = set()
    for path in (EXISTING, DONE_FILE):
        try:
            with open(path) as f:
                before = len(titles)
                titles.update(l.strip() for l in f if l.strip())
                print(f"  {path}: {len(titles)-before:,}件")
        except FileNotFoundError:
            pass
    print(f"  → 合計スキップ対象: {len(titles):,}件\n")
    return titles

# ── バッチアップロード ─────────────────────────────────────────────────────────
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

# ── バッチ処理 ─────────────────────────────────────────────────────────────────
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
        # フォールバック: 個別送信
        for title, html in articles:
            if upload_single(title, html):
                with _lock:
                    done_fh.write(title + "\n")
                done_fh.flush()
                _inc("up")
            else:
                _inc("fa")
    return processed

# ── ストリーム処理（1回分）────────────────────────────────────────────────────
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
                print(f"\n内部ファイル: {member.name}  ({size_mb:,.0f} MB展開後)")

                with ThreadPoolExecutor(max_workers=WORKERS) as ex:
                    futures = {}
                    pending = []   # (title, html) を貯める

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

# ── メイン ────────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print(" Phoenix Mesh — Wikipedia Dump Importer v3 (Batch)")
    print("=" * 60)
    print(f"  送信先: {BATCH_URL}")
    print(f"  並列数: {WORKERS} threads × {BATCH_SIZE}件/batch\n")

    existing = load_existing()
    done_fh  = open(DONE_FILE, "a", buffering=1)

    for attempt in range(1, MAX_RECONN + 1):
        if attempt > 1:
            wait = min(30 * attempt, 180)
            print(f"\n再接続 {attempt}/{MAX_RECONN}... {wait}秒待機")
            time.sleep(wait)
            existing = load_existing()

        print(f"ストリームDL開始 (試行 {attempt}/{MAX_RECONN})")
        try:
            stream_once(existing, done_fh)
            print("\n全ファイル正常完了！")
            break
        except KeyboardInterrupt:
            print("\n中断しました。")
            break
        except tarfile.ReadError as e:
            print(f"\n切断: {e} → 自動再接続")
        except Exception as e:
            print(f"\nエラー: {e} → 自動再接続")

    done_fh.close()
    _progress(force=True)
    elapsed = time.time() - _t0
    print(f"""

{'=' * 60}
 完了レポート
{'=' * 60}
  アップロード: {_uploaded:,} 件
  スキップ    : {_skipped:,} 件（既存 or 空）
  失敗        : {_failed:,} 件
  所要時間    : {elapsed/3600:.2f} 時間
  平均速度    : {_uploaded/elapsed:.0f} 件/秒
{'=' * 60}
""")

if __name__ == "__main__":
    main()
