#!/usr/bin/env python3
"""
Phoenix Mesh — Wikipedia Enterprise HTML Dump 一括インポーター v2
- ストリーム処理（メモリ ~100MB以下、ディスク使用ゼロ）
- 切断時自動再接続（最大10回）
- 今回アップ済みをDONE_FILEに記録して再接続後スキップ
"""

import urllib.request
import tarfile
import json
import sys
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── 設定 ──────────────────────────────────────────────────────────────────────
DUMP_URL    = "https://dumps.wikimedia.org/other/enterprise_html/runs/20250320/jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz"
SUBMIT_URL  = "https://wikipedia-is-dead.com/api/contribute/submit"
EXISTING    = "/tmp/existing_titles.txt"
DONE_FILE   = "/tmp/phoenix_done_this_run.txt"
WORKERS     = 50
LOG_EVERY   = 500
RETRY_UP    = 3       # アップロードリトライ
MAX_RECONN  = 10      # 最大再接続回数

# ── 統計 ──────────────────────────────────────────────────────────────────────
_lock     = threading.Lock()
_uploaded = 0
_skipped  = 0
_failed   = 0
_t0       = time.time()

def _inc(key):
    global _uploaded, _skipped, _failed
    with _lock:
        if   key == "up": _uploaded += 1
        elif key == "sk": _skipped  += 1
        elif key == "fa": _failed   += 1

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

# ── アップロード ───────────────────────────────────────────────────────────────
def upload(title, html):
    data = json.dumps({"title": title, "html": html}).encode()
    for attempt in range(RETRY_UP):
        try:
            req = urllib.request.Request(
                SUBMIT_URL, data=data,
                headers={"Content-Type": "application/json",
                         "User-Agent": "PhoenixMesh-DumpImport/2.0"}
            )
            with urllib.request.urlopen(req, timeout=45) as r:
                if r.status == 200:
                    return True
        except Exception:
            if attempt < RETRY_UP - 1:
                time.sleep(1.5 ** attempt)
    return False

# ── 1行（記事JSON）処理 ───────────────────────────────────────────────────────
def process_line(line, existing, done_fh):
    if not line or not line.strip():
        return "sk"
    try:
        obj   = json.loads(line)
        title = obj.get("name", "").strip()
        html  = obj.get("article_body", {}).get("html", "")
        if not title or len(html) < 500:
            return "sk"
        if title in existing:
            return "sk"
        ok = upload(title, html)
        if ok:
            done_fh.write(title + "\n")
            return "up"
        return "fa"
    except Exception:
        return "fa"

# ── ストリーム処理（1回分）────────────────────────────────────────────────────
def stream_once(existing, done_fh):
    req = urllib.request.Request(
        DUMP_URL,
        headers={"User-Agent": "PhoenixMesh-DumpImport/2.0"}
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
                    batch   = []

                    def flush_batch(b):
                        for ln in b:
                            fut = ex.submit(process_line, ln, existing, done_fh)
                            futures[fut] = True

                    def collect():
                        done = [f for f in list(futures) if f.done()]
                        for f in done:
                            _inc(f.result())
                            del futures[f]
                        _progress()

                    for raw in fobj:
                        try:
                            line = raw.decode("utf-8", errors="replace")
                        except Exception:
                            continue
                        batch.append(line)
                        if len(batch) >= WORKERS * 4:
                            flush_batch(batch)
                            batch = []
                        if len(futures) >= WORKERS * 8:
                            collect()

                    if batch:
                        flush_batch(batch)
                    for f in as_completed(list(futures)):
                        _inc(f.result())
                        _progress()

    return True  # 正常完了

# ── メイン ────────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print(" Phoenix Mesh — Wikipedia Dump Importer v2")
    print("=" * 60)
    print(f"  送信先: {SUBMIT_URL}")
    print(f"  並列数: {WORKERS} threads\n")

    existing = load_existing()

    done_fh = open(DONE_FILE, "a", buffering=1)

    for attempt in range(1, MAX_RECONN + 1):
        if attempt > 1:
            wait = min(30 * attempt, 180)
            print(f"\n再接続 {attempt}/{MAX_RECONN}... {wait}秒待機")
            time.sleep(wait)
            existing = load_existing()  # DONE_FILEをスキップセットに追加

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
