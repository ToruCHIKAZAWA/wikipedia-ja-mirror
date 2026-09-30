const BATCH_SIZE = 20; // フルページHTML取得のため保守的に設定
const WP = 'https://ja.wikipedia.org';

// ─── Service Worker スクリプト（Tier 2） ───────────────────────────────────
const SW_SCRIPT = `
const CACHE = 'wikipedia-ipfs-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/wiki/')) return;
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        const fresh = fetch(event.request).then(res => {
          cache.put(event.request, res.clone());
          return res;
        });
        return cached || fresh;
      })
    )
  );
});
`;

// ─── ダッシュボード HTML ────────────────────────────────────────────────────
function buildDashboard() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mirror — Wikipedia</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#070707;--surface:#0d0d0d;--fg:#efefef;--fg-mid:#484848;--fg-dim:#1e1e1e;
  --border:rgba(255,255,255,0.055);
}
html,body{
  background:var(--bg);color:var(--fg);min-height:100vh;
  font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5;
}
header{
  display:flex;align-items:center;justify-content:space-between;
  padding:30px 52px;border-bottom:1px solid var(--border);
}
.wordmark{
  font-size:11px;font-weight:500;letter-spacing:0.2em;
  text-transform:uppercase;color:var(--fg-mid);
}
.badge{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--fg-mid);letter-spacing:0.04em}
.dot{width:5px;height:5px;border-radius:50%;background:#34d399;flex-shrink:0}
.dot.running{animation:pulse 2.4s ease-in-out infinite}
.dot.done{background:#60a5fa;animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
main{max-width:720px;margin:0 auto;padding:80px 52px}
.hero{margin-bottom:64px}
.num{
  font-size:76px;font-weight:200;letter-spacing:-4px;line-height:1;
  font-variant-numeric:tabular-nums;margin-bottom:8px;
}
.label{font-size:11px;text-transform:uppercase;letter-spacing:0.14em;color:var(--fg-mid)}
.prog-row{display:flex;justify-content:space-between;margin-bottom:10px;font-size:11px}
.prog-pct{color:var(--fg-mid);font-variant-numeric:tabular-nums}
.prog-target{color:var(--fg-dim)}
.track{height:1px;background:var(--fg-dim);border-radius:1px;position:relative;overflow:hidden;margin-bottom:60px}
.fill{position:absolute;inset:0;right:auto;background:var(--fg);border-radius:1px;transition:width 0.9s cubic-bezier(.4,0,.2,1)}
.grid{
  display:grid;grid-template-columns:repeat(3,1fr);
  border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:48px;
}
.cell{background:var(--surface);padding:24px 28px;border-right:1px solid var(--border)}
.cell:last-child{border-right:none}
.cell-num{font-size:26px;font-weight:300;letter-spacing:-0.5px;margin-bottom:6px;font-variant-numeric:tabular-nums}
.cell-label{font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:var(--fg-mid)}
.rows{border-top:1px solid var(--border);padding-top:32px;display:flex;flex-direction:column;gap:18px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.row-key{font-size:10px;text-transform:uppercase;letter-spacing:0.14em;color:var(--fg-mid);white-space:nowrap}
.row-val{font-size:13px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}
.row-val.dim{color:var(--fg-mid)}
footer{
  border-top:1px solid var(--border);padding:22px 52px;
  text-align:center;font-size:11px;color:var(--fg-dim);letter-spacing:0.06em;
}
</style>
</head>
<body>
<header>
  <span class="wordmark">Wikipedia Mirror</span>
  <div class="badge"><div class="dot running" id="dot"></div><span id="st-label">稼働中</span></div>
</header>
<main>
  <div class="hero">
    <div class="num" id="hero">—</div>
    <div class="label">ミラー済み記事</div>
  </div>
  <div class="prog-row">
    <span class="prog-pct" id="pct">— %</span>
    <span class="prog-target">目標 1,400,000</span>
  </div>
  <div class="track"><div class="fill" id="fill" style="width:0"></div></div>
  <div class="grid">
    <div class="cell">
      <div class="cell-num" id="ipfs">—</div>
      <div class="cell-label">IPFS ピン済み</div>
    </div>
    <div class="cell">
      <div class="cell-num" id="rate">20</div>
      <div class="cell-label">記事 / 分</div>
    </div>
    <div class="cell">
      <div class="cell-num" id="eta">—</div>
      <div class="cell-label">完了まで</div>
    </div>
  </div>
  <div class="rows">
    <div class="row">
      <span class="row-key">最新処理記事</span>
      <span class="row-val" id="last-t">—</span>
    </div>
    <div class="row">
      <span class="row-key">最終更新</span>
      <span class="row-val" id="last-u">—</span>
    </div>
    <div class="row">
      <span class="row-key">インフラ</span>
      <span class="row-val dim">Cloudflare Workers · R2 · D1 · IPFS</span>
    </div>
  </div>
</main>
<footer>30秒ごとに自動更新</footer>
<script>
const TARGET = 1_400_000, RATE = 20;
async function tick() {
  const d = await fetch('/stats').then(r => r.json()).catch(() => null);
  if (!d) return;
  const n = d.total_articles ?? 0;
  const pct = n / TARGET * 100;
  const days = Math.ceil((TARGET - n) / (RATE * 1440));
  document.getElementById('hero').textContent = n.toLocaleString('ja-JP');
  document.getElementById('pct').textContent = pct.toFixed(3) + ' %';
  document.getElementById('fill').style.width = Math.min(pct, 100) + '%';
  document.getElementById('ipfs').textContent = (d.with_ipfs_cid ?? 0).toLocaleString('ja-JP');
  document.getElementById('last-t').textContent = d.last_title || '—';
  if (d.last_updated) {
    document.getElementById('last-u').textContent = new Date(d.last_updated + 'Z')
      .toLocaleString('ja-JP', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  if (d.status === 'completed') {
    document.getElementById('eta').textContent = '完了';
    document.getElementById('dot').className = 'dot done';
    document.getElementById('st-label').textContent = '完了';
  } else {
    document.getElementById('eta').textContent = days + ' 日';
  }
}
tick(); setInterval(tick, 30_000);
</script>
</body>
</html>`;
}

// ─── P2P UI + スクリプト注入（Tier 1, 2, 3） ──────────────────────────────
function buildP2POverlay(title, cid) {
  const safeTitle = JSON.stringify(title);
  const cidDisplay = cid || "IPFSに未登録";
  const cidShort   = cid ? cid.slice(0, 20) + "…" : "未登録";

  return /* html */`
<!-- ── IPFS P2P バー（Tier 1） ── -->
<div id="ipfs-bar" style="position:fixed;bottom:0;left:0;right:0;background:#0f172a;color:#e2e8f0;
  font-family:-apple-system,'Hiragino Sans',sans-serif;font-size:13px;padding:8px 16px;
  display:flex;align-items:center;justify-content:space-between;z-index:9999;
  border-top:2px solid #3b82f6;gap:12px;flex-wrap:wrap;">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
    <span style="color:#60a5fa;font-weight:700;">📡 IPFS Mirror</span>
    <span style="color:#475569;">CID:</span>
    <code id="cid-display" data-cid="${cid || ''}"
      title="${cidDisplay}"
      style="color:#a5b4fc;font-size:11px;cursor:pointer;"
      onclick="copyCid()">${cidShort}</code>
    <span id="p2p-badge" style="font-size:11px;color:#475569;background:#1e293b;
      padding:2px 8px;border-radius:10px;">SW: 待機中</span>
  </div>
  <div style="display:flex;align-items:center;gap:8px;">
    <button id="btn-verify" onclick="startP2PVerify()"
      style="background:#1d4ed8;color:white;border:none;border-radius:6px;
      padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">
      🔍 P2P検証
    </button>
    <button onclick="document.getElementById('ipfs-modal').style.display='flex'"
      style="background:#3b82f6;color:white;border:none;border-radius:6px;
      padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">
      🌐 分散保存に参加
    </button>
    <button onclick="document.getElementById('ipfs-bar').style.display='none'"
      style="background:transparent;color:#475569;border:none;cursor:pointer;font-size:18px;">×</button>
  </div>
</div>

<!-- ── 参加モーダル（Tier 1） ── -->
<div id="ipfs-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);
  z-index:10000;align-items:center;justify-content:center;padding:16px;">
  <div style="background:#1e293b;border-radius:14px;padding:28px;max-width:500px;width:100%;
    border:1px solid #334155;max-height:90vh;overflow-y:auto;">
    <h2 style="color:#f1f5f9;margin:0 0 6px;font-size:18px;">🌐 分散保存に参加する</h2>
    <p style="color:#94a3b8;margin:0 0 20px;font-size:13px;">
      このページのCIDを固定することで、Wikipediaの検閲耐性と可用性を高めることができます。
    </p>
    <div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:12px;">
      <div style="color:#94a3b8;font-size:11px;margin-bottom:4px;">このページのCID</div>
      <code style="color:#a5b4fc;font-size:12px;word-break:break-all;">${cidDisplay}</code>
    </div>
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:10px;">
      <div style="color:#60a5fa;font-weight:700;margin-bottom:6px;">方法1: IPFS Companion（一番簡単）</div>
      <p style="color:#94a3b8;font-size:12px;margin:0 0 10px;">ブラウザ拡張をインストールするだけ。</p>
      <a href="https://github.com/ipfs/ipfs-companion#install" target="_blank" rel="noopener"
        style="display:inline-block;background:#3b82f6;color:white;text-decoration:none;
        border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;">
        IPFS Companionをインストール →
      </a>
    </div>
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:10px;">
      <div style="color:#60a5fa;font-weight:700;margin-bottom:6px;">方法2: コマンドライン</div>
      <pre style="background:#020617;color:#86efac;padding:10px;border-radius:6px;
        font-size:12px;margin:0;overflow-x:auto;">ipfs pin add ${cidDisplay}</pre>
    </div>
    <div style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:20px;">
      <div style="color:#60a5fa;font-weight:700;margin-bottom:6px;">方法3: Pinata API</div>
      <pre style="background:#020617;color:#86efac;padding:10px;border-radius:6px;
        font-size:11px;margin:0;overflow-x:auto;white-space:pre-wrap;">curl -X POST https://api.pinata.cloud/pinning/pinByHash \\
  -H "Authorization: Bearer YOUR_PINATA_JWT" \\
  -H "Content-Type: application/json" \\
  -d '{"hashToPin":"${cidDisplay}"}'</pre>
    </div>
    <button onclick="document.getElementById('ipfs-modal').style.display='none'"
      style="background:#334155;color:#cbd5e1;border:none;border-radius:8px;
      padding:10px;cursor:pointer;width:100%;font-size:14px;">閉じる</button>
  </div>
</div>

<!-- ── P2Pスクリプト（Tier 2 + Tier 3） ── -->
<script>
const PAGE_CID   = document.getElementById('cid-display')?.dataset.cid || '';
const PAGE_TITLE = ${safeTitle};
const badge      = document.getElementById('p2p-badge');
const btnVerify  = document.getElementById('btn-verify');

function copyCid() {
  if (!PAGE_CID) return;
  navigator.clipboard.writeText(PAGE_CID).then(() => {
    const el = document.getElementById('cid-display');
    if (el) { el.style.color = '#4ade80'; setTimeout(() => el.style.color = '#a5b4fc', 2000); }
  });
}

if ('serviceWorker' in navigator) {
  const swUrl = window.location.origin + '/sw.js';
  navigator.serviceWorker.register(swUrl, { scope: window.location.origin + '/' }).then(reg => {
    const state = reg.active ? '✅ 有効' : '🔄 起動中';
    if (badge) badge.textContent = 'SW: ' + state;
    if (badge) badge.style.color = '#4ade80';
  }).catch(err => {
    if (badge) badge.textContent = 'SW: ' + (err?.name || '無効');
  });
}

async function startP2PVerify() {
  if (!PAGE_CID) { alert('このページはまだIPFSに登録されていません'); return; }
  if (btnVerify) { btnVerify.disabled = true; btnVerify.textContent = '🔄 接続中…'; }
  if (badge) badge.textContent = 'P2P: 接続中…';
  if (window.ipfs) {
    try {
      await window.ipfs.pin.add(PAGE_CID);
      if (badge) { badge.textContent = '✅ P2Pピン済み'; badge.style.color = '#4ade80'; }
      if (btnVerify) btnVerify.textContent = '✅ ピン完了';
      return;
    } catch {}
  }
  try {
    if (badge) badge.textContent = 'P2P: Heliaロード中…';
    const { createVerifiedFetch } = await import('https://esm.sh/@helia/verified-fetch@2');
    if (badge) badge.textContent = 'P2P: IPFS検索中…';
    const vf = await createVerifiedFetch();
    const res = await vf('ipfs://' + PAGE_CID, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      if (badge) { badge.textContent = '✅ P2P検証済み'; badge.style.color = '#4ade80'; }
      if (btnVerify) btnVerify.textContent = '✅ 検証済み';
    } else { throw new Error(); }
  } catch {
    if (badge) { badge.textContent = '⚠️ P2P到達不可'; badge.style.color = '#f59e0b'; }
    if (btnVerify) { btnVerify.disabled = false; btnVerify.textContent = '🔍 再試行'; }
  }
}
</script>
`;
}

// ─── WikipediaのHTMLを本家そのままの見た目に整える ──────────────────────────
// <base>タグを除去しつつ、CSSやJSのパスをWikipediaの絶対URLに書き換える
function prepareHTML(html) {
  return html
    // <base>タグ除去（SW登録やリンク解決を正しくするため）
    .replace(/<base\b[^>]*>/gi, '')
    // CSP metaタグ除去
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*\/?>/gi, '')
    // /w/, /static/, /api/, /skins/, /extensions/, /resources/ パスをWikipedia絶対URLに
    .replace(
      /((?:href|src|action)=["'])(\/(?:w|static|skins|extensions|resources|api)\/)/g,
      (_, attr, path) => attr + WP + path
    )
    // srcset内のパスも修正
    .replace(/srcset="([^"]+)"/g, (_, set) =>
      'srcset="' + set.replace(/(^|,\s*)(\/(?!\/)\S+)/g, (m, sep, p) => sep + WP + p) + '"'
    );
}

// ─── 記事HTMLにP2Pオーバーレイを注入 ──────────────────────────────────────
function injectP2P(html, title, cid) {
  const prepared = prepareHTML(html);
  const overlay  = buildP2POverlay(title, cid);
  if (prepared.includes("</body>")) {
    return prepared.replace("</body>", overlay + "\n</body>");
  }
  return prepared + overlay;
}

// ─── Pinata IPFS アップロード ──────────────────────────────────────────────
async function pinToIPFS(jwt, title, html) {
  const formData = new FormData();
  const blob = new Blob([html], { type: "text/html; charset=utf-8" });
  formData.append("file", blob, `${title}.html`);
  formData.append("pinataMetadata", JSON.stringify({ name: `wikipedia-ja:${title}` }));
  formData.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}`);
  return (await res.json()).IpfsHash;
}

// ─── 1バッチ処理（Cronから呼ばれる） ──────────────────────────────────────
async function processBatch(env) {
  const progress = await env.DB.prepare(
    "SELECT * FROM upload_progress WHERE id = 1"
  ).first();
  if (progress?.status === "completed") return { done: true };

  const continueToken = progress?.last_continue_token ?? "";
  const params = new URLSearchParams({
    action: "query", list: "allpages",
    aplimit: String(BATCH_SIZE), apnamespace: "0", format: "json",
    ...(continueToken ? { apcontinue: continueToken } : {}),
  });

  const listRes = await fetch(`${WP}/w/api.php?${params}`, {
    headers: { "User-Agent": "WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)" },
  });
  if (!listRes.ok) throw new Error(`Wikipedia API ${listRes.status}`);
  const listJson = await listRes.json();
  const pages     = listJson.query?.allpages ?? [];
  const nextToken = listJson.continue?.apcontinue ?? null;

  if (pages.length === 0) {
    await env.DB.prepare(
      "UPDATE upload_progress SET status='completed', updated_at=datetime('now') WHERE id=1"
    ).run();
    return { done: true };
  }

  // 本家WikipediaのフルページHTMLを並列フェッチ（Vector skinそのまま）
  const htmlResults = await Promise.all(
    pages.map(async (page) => {
      try {
        const res = await fetch(
          `${WP}/wiki/${encodeURIComponent(page.title)}`,
          { headers: {
            "User-Agent": "WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)",
            "Accept": "text/html,application/xhtml+xml",
          }}
        );
        if (!res.ok) return null;
        return { title: page.title, html: await res.text() };
      } catch { return null; }
    })
  );

  const pairs = [];
  for (const item of htmlResults) {
    if (!item) continue;
    let cid = "";
    if (env.PINATA_JWT) {
      try { cid = await pinToIPFS(env.PINATA_JWT, item.title, item.html); } catch {}
    }
    pairs.push({ title: item.title, cid, html: item.html });
  }

  if (pairs.length > 0) {
    // HTMLをR2に並列書き込み
    await Promise.all(
      pairs.map(({ title, html }) =>
        env.HTML_BUCKET.put(title, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        })
      )
    );

    // タイトル→CIDをD1に記録
    const stmt = env.DB.prepare(
      `INSERT INTO articles (title, cid, uploaded_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(title) DO UPDATE SET cid=excluded.cid, uploaded_at=excluded.uploaded_at`
    );
    await env.DB.batch(pairs.map(({ title, cid }) => stmt.bind(title, cid)));
  }

  const newStatus = nextToken ? "running" : "completed";
  await env.DB.prepare(
    `UPDATE upload_progress
     SET last_title=?, last_continue_token=?, total_count=total_count+?, status=?, updated_at=datetime('now')
     WHERE id=1`
  ).bind(pages.at(-1)?.title ?? "", nextToken ?? "", pairs.length, newStatus).run();

  return { processed: pairs.length, nextToken };
}

// ─── IPFS ゲートウェイフォールバック ──────────────────────────────────────
const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs",
  "https://dweb.link/ipfs",
  "https://w3s.link/ipfs",
  "https://ipfs.io/ipfs",
];

async function fetchFromIPFS(cid, timeoutMs = 8000) {
  for (const gw of GATEWAYS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${gw}/${cid}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return res;
    } catch {}
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ─── Worker エクスポート ───────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processBatch(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ダッシュボード
    if (pathname === "/" || pathname === "/dashboard") {
      return new Response(buildDashboard(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Service Worker スクリプト
    if (pathname === "/sw.js") {
      return new Response(SW_SCRIPT, {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-cache",
          "Service-Worker-Allowed": "/",
        },
      });
    }

    // /stats
    if (pathname === "/stats") {
      const progress = await env.DB.prepare("SELECT * FROM upload_progress WHERE id=1").first();
      const count    = await env.DB.prepare("SELECT COUNT(*) AS n FROM articles").first();
      const withCid  = await env.DB.prepare("SELECT COUNT(*) AS n FROM articles WHERE cid != ''").first();
      return json({
        total_articles: count?.n ?? 0,
        with_ipfs_cid:  withCid?.n ?? 0,
        status:      progress?.status ?? "unknown",
        last_title:  progress?.last_title ?? "",
        last_updated: progress?.updated_at ?? null,
        batch_size:  BATCH_SIZE,
      });
    }

    // /cid/{記事名}
    if (pathname.startsWith("/cid/")) {
      const title = decodeURIComponent(pathname.slice(5));
      const row = await env.DB.prepare("SELECT cid FROM articles WHERE title=?").bind(title).first();
      if (!row) return json({ error: "not found" }, 404);
      return json({ title, cid: row.cid });
    }

    // /admin/upload/run
    if (pathname === "/admin/upload/run") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return json(await processBatch(env));
    }

    // /admin/reindex ── 既存記事をフルページHTMLで再取得（20件ずつ）
    if (pathname === "/admin/reindex") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const rows = await env.DB.prepare(
        "SELECT title FROM articles ORDER BY uploaded_at ASC LIMIT 20"
      ).all();
      let done = 0;
      for (const { title } of rows.results ?? []) {
        try {
          const res = await fetch(
            `${WP}/wiki/${encodeURIComponent(title)}`,
            { headers: {
              "User-Agent": "WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)",
              "Accept": "text/html,application/xhtml+xml",
            }}
          );
          if (!res.ok) continue;
          const html = await res.text();
          await env.HTML_BUCKET.put(title, html, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          });
          await env.DB.prepare(
            "UPDATE articles SET uploaded_at=datetime('now') WHERE title=?"
          ).bind(title).run();
          done++;
        } catch {}
      }
      return json({ reindexed: done });
    }

    // /admin/migrate-to-r2 ── 旧D1 HTMLをR2に移行
    if (pathname === "/admin/migrate-to-r2") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const rows = await env.DB.prepare(
        "SELECT title, html FROM articles WHERE html IS NOT NULL AND html != '' LIMIT 50"
      ).all();
      let migrated = 0;
      for (const { title, html } of rows.results ?? []) {
        await env.HTML_BUCKET.put(title, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        });
        await env.DB.prepare("UPDATE articles SET html = NULL WHERE title = ?").bind(title).run();
        migrated++;
      }
      return json({ migrated, remaining: (rows.results?.length ?? 0) === 50 ? "more" : "done" });
    }

    // /wiki/{記事名} ── 記事配信
    const m = pathname.match(/^\/wiki\/(.+)$/);
    if (!m) return new Response("Not Found", { status: 404 });
    const title = decodeURIComponent(m[1]);

    const row = await env.DB.prepare(
      "SELECT cid, html FROM articles WHERE title=?"
    ).bind(title).first();

    if (!row) {
      return new Response(
        `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<title>${title} — Wikipedia IPFS Mirror</title></head>
<body style="font-family:sans-serif;padding:40px;">
<h1>「${title}」は見つかりません</h1>
<p>まだインデックスされていません。<a href="https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}" target="_blank">Wikipedia で読む →</a></p>
${buildP2POverlay(title, "")}
</body></html>`,
        { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    const { cid, html: d1Html } = row;

    // 1. R2から配信（優先）
    const r2obj = await env.HTML_BUCKET.get(title);
    if (r2obj) {
      const html = await r2obj.text();
      const body = injectP2P(html, title, cid);
      return new Response(body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "X-IPFS-CID": cid || "",
          "X-Served-By": "r2",
        },
      });
    }

    // 2. D1レガシーHTMLから配信
    if (d1Html) {
      const body = injectP2P(d1Html, title, cid);
      return new Response(body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "X-IPFS-CID": cid || "",
          "X-Served-By": "d1-legacy",
        },
      });
    }

    // 3. IPFSゲートウェイフォールバック
    if (cid) {
      const ipfsRes = await fetchFromIPFS(cid);
      if (ipfsRes) {
        const rawHtml = await ipfsRes.text();
        const body = injectP2P(rawHtml, title, cid);
        return new Response(body, {
          headers: { "Content-Type": "text/html; charset=utf-8", "X-IPFS-CID": cid, "X-Served-By": "ipfs" },
        });
      }
    }

    return new Response("コンテンツを取得できませんでした", { status: 502 });
  },
};
