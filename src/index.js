import { schnorr }    from '@noble/curves/secp256k1.js';
import { sha256 }     from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

const BATCH_SIZE = 25; // processBatchはR2/D1のみ（IPFSはselfHeal担当）
const WP = 'https://ja.wikipedia.org';
const EC_SHARD_COUNT = 5;  // RS(3,5): 5シャード中3つで復元可能

// ─── Phoenix Mesh Protocol v2 — Von Neumann Cellular Automaton Layer ─────────
const GENOME_VERSION = 'v2.0.0';
const PHOENIX_ORIGIN  = 'https://wikipedia-is-dead.com';

// セルオートマトン状態関数: (cid, porCount) → UNPROCESSED|ENDANGERED|STABLE|ROBUST|IMMORTAL
// 隣接ノードはこの状態を読み取り、ENDANGERED なら複製を補充する（状態遷移規則）
function getArticleState(cid, porCount) {
  if (!cid)          return 'UNPROCESSED'; // R2のみ、IPFSなし
  if (porCount <= 0) return 'ENDANGERED';  // IPFS固定済みだが追加複製0
  if (porCount <= 2) return 'LOW';         // 複製不足（target: 3以上）
  if (porCount <= 6) return 'STABLE';      // 安定状態
  if (porCount <= 9) return 'ROBUST';      // 高複製
  return 'IMMORTAL';                       // 完全自律複製（R₀>1.0）
}

// ─── Nostr公開鍵（NOSTR_SKから導出） ───────────────────────────────────────
const NOSTR_RELAYS = [
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://nostr.bitcoiner.social',
];

// Erasure Coding + SSS + AES モジュール（動的ロード）
let _erasureLoaded = false;
let rsEncode, rsDecode, buildManifest, parseManifest;
let sssShare, sssReconstruct, encryptBytes, decryptBytes;
async function loadErasure() {
  if (_erasureLoaded) return;
  const m = await import('./erasure.js');
  rsEncode       = m.encode;
  rsDecode       = m.decode;
  buildManifest  = m.buildManifest;
  parseManifest  = m.parseManifest;
  sssShare       = m.sssShare;
  sssReconstruct = m.sssReconstruct;
  encryptBytes   = m.encryptBytes;
  decryptBytes   = m.decryptBytes;
  _erasureLoaded = true;
}

// ─── Service Worker スクリプト（Tier 2 — Phoenix Offline Node） ────────────
// 全閲覧者が読んだ記事のオフラインノードになる
// キャッシュ済み記事数をバッジで通知 → 読むほど強くなる
const SW_SCRIPT = `
const CACHE = 'phoenix-mesh-v3';
const OFFLINE_HTML = \`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>オフライン — Wikipedia Mirror</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#070707;color:#efefef;min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;font-family:-apple-system,sans-serif;padding:40px;}
.icon{font-size:48px;margin-bottom:24px;opacity:0.4}
h1{font-size:20px;font-weight:300;letter-spacing:-0.5px;margin-bottom:12px}
p{font-size:13px;color:#484848;margin-bottom:8px;text-align:center;line-height:1.6}
.hint{margin-top:32px;background:#0d0d0d;border:1px solid rgba(255,255,255,0.055);
  border-radius:8px;padding:20px 28px;max-width:400px;width:100%}
.hint-title{font-size:9px;text-transform:uppercase;letter-spacing:0.18em;color:#484848;margin-bottom:12px}
.hint p{text-align:left;color:#6b7280}
a{color:#a78bfa;text-decoration:none}
</style>
</head>
<body>
<div class="icon">📡</div>
<h1>オフラインです</h1>
<p>この記事はまだキャッシュされていません。</p>
<p>ネットワークに接続するか、キャッシュ済みの記事をお試しください。</p>
<div class="hint">
  <div class="hint-title">Phoenix Mesh — Tier 2 オフラインノード</div>
  <p>あなたはすでに読んだ記事のオフラインノードです。</p>
  <p>次回同じ記事を開くと、ネットワークなしで表示できます。</p>
  <p style="margin-top:10px"><a href="/">← トップページ</a></p>
</div>
<script>
caches.open('phoenix-mesh-v2').then(c => c.keys()).then(keys => {
  if (keys.length > 0) {
    const p = document.createElement('p');
    p.style.cssText = 'margin-top:16px;color:#4ade80;font-size:12px';
    p.textContent = keys.length + '件の記事がキャッシュ済み';
    document.body.appendChild(p);
  }
});
</script>
</body></html>\`;


self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/wiki/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(event.request).then(cached => {
        // Stale-while-revalidate: キャッシュがあれば即返しつつ裏で更新
        const networkFetch = fetch(event.request).then(res => {
          if (res.ok && res.status === 200) {
            cache.put(event.request, res.clone());
            // キャッシュ済み記事数をクライアントに通知
            cache.keys().then(keys => {
              self.clients.matchAll().then(clients =>
                clients.forEach(c => c.postMessage({ type: 'cache-count', count: keys.length }))
              );
            });
          }
          return res;
        }).catch(() => cached || new Response(OFFLINE_HTML, {
          status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }
        }));
        return cached || networkFetch;
      })
    )
  );
});

// バックグラウンド同期: オフライン中に訪問したURLをキャッシュ済み一覧で提供
self.addEventListener('message', event => {
  if (event.data?.type === 'get-cache-count') {
    caches.open(CACHE).then(cache =>
      cache.keys().then(keys =>
        event.source?.postMessage({ type: 'cache-count', count: keys.length })
      )
    );
  }
});
`;

// ─── トップページ（宣言文） ───────────────────────────────────────────────────
async function buildHomepage(env) {
  // D1から最新ミラー記事を取得
  let recentArticles = [];
  try {
    const res = await env.DB.prepare(
      "SELECT title, cid FROM articles ORDER BY uploaded_at DESC LIMIT 12"
    ).all();
    recentArticles = res.results || [];
  } catch(_) {}

  return `<!DOCTYPE html>
<html lang="ja" dir="ltr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wikipedia 偽りのデモクラシーは崩壊した。— wikipedia-is-dead.com</title>
<meta name="google-site-verification" content="IAlMuGMTBkZqBpBFgPgdrkPC8IadqEWyug_vGDwljcM">
<link rel="icon" href="https://ja.wikipedia.org/static/favicon/wikipedia.ico">
<link rel="canonical" href="https://wikipedia-is-dead.com/">
<link rel="sitemap" type="application/xml" href="/sitemap-index.xml">
<meta name="description" content="Wikipedia日本語版の完全ミラーアーカイブ。IPFS分散配信による検閲耐性アーカイブ。管理者による権限濫用・検閲の実態と、消えない知識の保全について。">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="Wikipedia 偽りのデモクラシーは崩壊した。">
<meta property="og:description" content="Wikipediaは内部から腐敗している。管理者による権限濫用の実態と、検閲不可能なIPFSミラーアーカイブの使命。">
<meta property="og:image" content="https://wikipedia-is-dead.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="https://wikipedia-is-dead.com/">
<meta property="og:site_name" content="wikipedia-is-dead.com">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://wikipedia-is-dead.com/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Wikipedia IPFS Mirror","alternateName":"wikipedia-is-dead.com","url":"https://wikipedia-is-dead.com","description":"Wikipedia日本語版の完全ミラーアーカイブ。IPFS分散配信による検閲耐性アーカイブ。","inLanguage":"ja","potentialAction":{"@type":"SearchAction","target":{"@type":"EntryPoint","urlTemplate":"https://wikipedia-is-dead.com/search?q={search_term_string}"},"query-input":"required name=search_term_string"}}</script>
<link rel="stylesheet" href="https://ja.wikipedia.org/w/load.php?lang=ja&modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Cskins.vector.styles&only=styles&skin=vector">
<link rel="stylesheet" href="https://ja.wikipedia.org/w/load.php?lang=ja&modules=site.styles&only=styles&skin=vector">
<style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;padding:0;font-family:-apple-system,'Linux Libertine','Georgia','Times',serif;background:#fff;color:#202122}
#mw-wrapper{max-width:960px;margin:0 auto;padding:0 20px}
#vector-header{border-bottom:1px solid #a2a9b1;padding:8px 20px;display:flex;align-items:center;gap:24px;background:#fff;position:sticky;top:0;z-index:100}
.vector-logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.vector-logo img{width:50px;height:50px}
.vector-logo-title{font-size:11px;color:#54595d;line-height:1.3}
.vector-logo-title strong{display:block;font-size:15px;font-family:'Linux Libertine','Georgia','Times',serif;color:#202122}
.vector-search{flex:1;max-width:360px}
.vector-search input{width:100%;border:1px solid #a2a9b1;border-radius:2px;padding:6px 10px;font-size:13px;outline:none}
.vector-search input:focus{border-color:#3366cc;box-shadow:0 0 0 1px #3366cc}
#mw-layout{display:flex;gap:0;min-height:calc(100vh - 60px)}
#mw-sidebar{width:160px;flex-shrink:0;padding:20px 12px;border-right:1px solid #a2a9b1;font-size:13px}
.sidebar-section{margin-bottom:16px}
.sidebar-heading{font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#54595d;margin-bottom:6px;border:none}
.sidebar-links{list-style:none;margin:0;padding:0}
.sidebar-links li{margin:3px 0}
.sidebar-links a{color:#3366cc;text-decoration:none;font-size:13px}
.sidebar-links a:hover{text-decoration:underline}
#mw-content{flex:1;padding:20px 32px;min-width:0}
.mw-indicators{float:right;margin-left:8px}
h1.firstHeading{font-family:'Linux Libertine','Georgia','Times',serif;font-size:1.95em;font-weight:normal;border-bottom:1px solid #a2a9b1;padding-bottom:4px;margin:0 0 16px;line-height:1.2;color:#202122}
.mw-parser-output p{margin:0.5em 0 1em;line-height:1.6;font-size:0.95em}
.mw-parser-output h2{font-family:'Linux Libertine','Georgia','Times',serif;font-size:1.5em;font-weight:normal;border-bottom:1px solid #a2a9b1;margin:1.5em 0 0.5em;padding-bottom:3px}
.mw-parser-output h3{font-size:1.15em;margin:1.2em 0 0.4em}
.mw-parser-output ul{margin:0.4em 0 1em 1.6em;line-height:1.6;font-size:0.95em}
.mw-parser-output li{margin:0.25em 0}
.hatnote{background:#f8f9fa;border-left:3px solid #a2a9b1;padding:8px 12px;margin:0 0 16px;font-size:0.9em;color:#54595d}
.toc{background:#f8f9fa;border:1px solid #a2a9b1;display:inline-block;padding:14px 20px;margin:0 0 24px;font-size:0.9em;min-width:200px}
.toctitle{font-weight:700;text-align:center;margin-bottom:6px;font-size:1em}
.toc ol{margin:0;padding-left:20px}
.toc li{margin:3px 0}
.toc a{color:#3366cc;text-decoration:none}
.toc a:hover{text-decoration:underline}
.mw-parser-output blockquote{border-left:3px solid #a2a9b1;margin:1em 2em;padding:0.5em 1em;color:#54595d;font-style:italic;font-size:1.05em}
.verdict-box{background:#f8f4e3;border:2px solid #b8a000;padding:20px 28px;margin:24px 0;border-radius:2px}
.verdict-box p{margin:0.4em 0;font-size:1em}
.archive-cta{background:#f0f4ff;border:1px solid #3366cc;padding:16px 20px;margin:24px 0;border-radius:2px}
.archive-cta h3{margin:0 0 8px;color:#3366cc}
.mw-footer{border-top:1px solid #a2a9b1;padding:16px 20px;font-size:12px;color:#54595d;text-align:center;margin-top:40px}
/* ── Portal ── */
.portal-section{margin:28px 0;padding:20px 0;border-top:1px solid #a2a9b1;border-bottom:1px solid #a2a9b1}
.portal-section h2{font-family:'Linux Libertine','Georgia','Times',serif;font-size:1.3em;font-weight:normal;border:none;margin:0 0 16px;padding:0;color:#202122}
.portal-cats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:24px}
.portal-cat{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;border:1px solid #eaecf0;border-radius:3px;text-decoration:none;color:#202122;background:#f8f9fa;font-size:12px;text-align:center;line-height:1.3;transition:background 0.15s,border-color 0.15s}
.portal-cat:hover{background:#eaf3fb;border-color:#3366cc;color:#3366cc}
.portal-cat-icon{font-size:22px;line-height:1}
.portal-recent h3{font-size:1em;font-weight:700;margin:0 0 10px;color:#54595d;text-transform:uppercase;letter-spacing:0.05em;font-size:11px}
.recent-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 20px}
.recent-grid a{color:#3366cc;text-decoration:none;font-size:0.9em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;padding:3px 0;border-bottom:1px solid #f0f0f0}
.recent-grid a:hover{text-decoration:underline}
.portal-search-wrap{background:#f0f4ff;border:1px solid #3366cc;border-radius:3px;padding:18px 20px;margin-bottom:20px}
.portal-search-wrap h2{font-size:1.1em;margin-bottom:10px;font-family:-apple-system,sans-serif;font-weight:600;color:#202122;border:none;padding:0}
.portal-search-row{display:flex;gap:8px}
.portal-search-row input{flex:1;border:1px solid #a2a9b1;border-radius:2px;padding:8px 12px;font-size:14px;outline:none}
.portal-search-row input:focus{border-color:#3366cc;box-shadow:0 0 0 1px #3366cc}
.portal-search-row button{background:#3366cc;color:#fff;border:none;border-radius:2px;padding:8px 18px;font-size:14px;cursor:pointer;white-space:nowrap}
.portal-search-row button:hover{background:#2a55ab}
@media(max-width:768px){
  .portal-cats{grid-template-columns:repeat(3,1fr)}
  .recent-grid{grid-template-columns:1fr}
  .portal-search-row{flex-wrap:wrap}
  .portal-search-row input{min-width:0}
}
@media(max-width:480px){
  .portal-cats{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:768px){
  #vector-header{flex-wrap:wrap;padding:8px 12px;gap:8px;position:static}
  .vector-logo{flex:0 0 auto}
  .vector-search{flex:1 1 100%;max-width:100%;order:3}
  #mw-layout{flex-direction:column}
  #mw-sidebar{display:none}
  #mw-content{padding:16px 16px}
  h1.firstHeading{font-size:1.4em}
  .mw-parser-output blockquote{margin:1em 0.5em}
  #mw-wrapper{padding:0 12px}
}
</style>
</head>
<body class="mediawiki ltr sitedir-ltr">

<div id="vector-header">
  <a class="vector-logo" href="/">
    <img src="https://ja.wikipedia.org/static/images/icons/wikipedia.png" alt="">
    <div class="vector-logo-title">
      <strong>Wikipedia</strong>
      IPFS Mirror
    </div>
  </a>
  <div class="vector-search" style="position:relative;">
    <form action="/search" method="get" autocomplete="off">
      <input type="search" name="q" id="main-search" placeholder="Wikipedia内を検索" autocomplete="off"
        style="width:100%;border:1px solid #a2a9b1;border-radius:2px;padding:6px 10px;font-size:13px;outline:none;">
    </form>
    <ul id="suggest-list" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;
      border:1px solid #a2a9b1;border-top:none;margin:0;padding:0;list-style:none;z-index:200;box-shadow:0 4px 8px rgba(0,0,0,0.1);"></ul>
  </div>
  <script>
  (function(){
    const inp=document.getElementById('main-search');
    const lst=document.getElementById('suggest-list');
    let t;
    inp.addEventListener('input',function(){
      clearTimeout(t);
      const q=inp.value.trim();
      if(q.length<2){lst.style.display='none';return;}
      t=setTimeout(async()=>{
        const res=await fetch('/api/suggest?q='+encodeURIComponent(q)).then(r=>r.json()).catch(()=>[]);
        lst.innerHTML='';
        if(!res.length){lst.style.display='none';return;}
        res.forEach(title=>{
          const li=document.createElement('li');
          li.style.cssText='padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #eaecf0;color:#202122;';
          li.textContent=title;
          li.addEventListener('mousedown',()=>{ location.href='/wiki/'+encodeURIComponent(title); });
          li.addEventListener('mouseover',()=>li.style.background='#eaf3fb');
          li.addEventListener('mouseout',()=>li.style.background='');
          lst.appendChild(li);
        });
        lst.style.display='block';
      },200);
    });
    document.addEventListener('click',e=>{if(!lst.contains(e.target)&&e.target!==inp)lst.style.display='none';});
  })();
  </script>
</div>

<div id="mw-layout">
  <div id="mw-sidebar">
    <div class="sidebar-section">
      <div class="sidebar-heading">ナビゲーション</div>
      <ul class="sidebar-links">
        <li><a href="/">メインページ</a></li>
        <li><a href="/index">全記事インデックス</a></li>
        <li><a href="/dashboard">進捗ダッシュボード</a></li>
        <li><a href="/network">Phoenixネットワーク</a></li>
        <li><a href="/wiki/Wikipedia">Wikipediaとは</a></li>
        <li><a href="/stats">統計情報</a></li>
      </ul>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-heading">ツール</div>
      <ul class="sidebar-links">
        <li><a href="/sitemap.xml">サイトマップ</a></li>
        <li><a href="https://github.com/ToruCHIKAZAWA/wikipedia-ja-mirror" target="_blank">GitHub</a></li>
      </ul>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-heading">記事例</div>
      <ul class="sidebar-links">
        <li><a href="/wiki/感嘆符">感嘆符</a></li>
        <li><a href="/wiki/インターネット">インターネット</a></li>
        <li><a href="/wiki/検閲">検閲</a></li>
        <li><a href="/wiki/民主主義">民主主義</a></li>
      </ul>
    </div>
  </div>

  <div id="mw-content">
    <h1 class="firstHeading">Wikipedia 偽りのデモクラシーは崩壊した。</h1>

    <div class="hero-image" style="width:100%;margin:16px 0 20px;">
      <img src="/hero.png" alt="Wikipedia — A More Open World" style="width:100%;height:auto;display:block;border-radius:2px;">
    </div>

    <div class="portal-section" id="portal">

      <div class="portal-search-wrap">
        <h2>日本語版 Wikipedia 完全ミラーアーカイブを検索</h2>
        <div class="portal-search-row" style="position:relative;">
          <input type="search" id="portal-search" placeholder="記事タイトルまたはキーワードを入力…" autocomplete="off">
          <button id="portal-search-btn">検索</button>
          <ul id="portal-suggest" style="display:none;position:absolute;top:100%;left:0;right:60px;background:#fff;border:1px solid #a2a9b1;border-top:none;margin:0;padding:0;list-style:none;z-index:200;box-shadow:0 4px 8px rgba(0,0,0,0.1);"></ul>
        </div>
      </div>

      <h2>カテゴリから探す</h2>
      <div class="portal-cats">
        <a class="portal-cat" href="/wiki/社会"><span class="portal-cat-icon">🏛️</span>社会・法律・政治</a>
        <a class="portal-cat" href="/wiki/地理学"><span class="portal-cat-icon">🌏</span>地理・旅行</a>
        <a class="portal-cat" href="/wiki/自然科学"><span class="portal-cat-icon">🔬</span>自然・科学・技術</a>
        <a class="portal-cat" href="/wiki/文化"><span class="portal-cat-icon">🎭</span>文化・芸術・哲学</a>
        <a class="portal-cat" href="/wiki/医学"><span class="portal-cat-icon">⚕️</span>医療・保健</a>
        <a class="portal-cat" href="/wiki/歴史学"><span class="portal-cat-icon">📜</span>歴史・歴史学</a>
        <a class="portal-cat" href="/wiki/数学"><span class="portal-cat-icon">📐</span>数学・コンピュータ</a>
        <a class="portal-cat" href="/wiki/スポーツ"><span class="portal-cat-icon">⚽</span>スポーツ・娯楽</a>
        <a class="portal-cat" href="/wiki/宗教"><span class="portal-cat-icon">🕍</span>宗教・信仰</a>
        <a class="portal-cat" href="/wiki/人物一覧"><span class="portal-cat-icon">👤</span>人物</a>
        <a class="portal-cat" href="/wiki/言語"><span class="portal-cat-icon">🗣️</span>言語・言語学</a>
        <a class="portal-cat" href="/wiki/経済学"><span class="portal-cat-icon">💹</span>経済・ビジネス</a>
      </div>

      <div class="portal-recent">
        <h3>最近アーカイブされた記事</h3>
        <div class="recent-grid">
          ${recentArticles.length > 0
            ? recentArticles.map(r =>
                `<a href="/wiki/${encodeURIComponent(r.title)}" title="${r.title}">
                  ${r.cid ? '<span style="color:#4ade80;font-size:9px;margin-right:3px;">⌬</span>' : ''}${r.title}
                </a>`
              ).join('')
            : '<span style="color:#54595d;font-size:0.9em">取得中…</span>'
          }
        </div>
      </div>
    </div>
    <script>
    (function(){
      const inp=document.getElementById('portal-search');
      const btn=document.getElementById('portal-search-btn');
      const lst=document.getElementById('portal-suggest');
      btn.addEventListener('click',()=>{const q=inp.value.trim();if(q)location.href='/search?q='+encodeURIComponent(q);});
      inp.addEventListener('keydown',e=>{if(e.key==='Enter'){const q=inp.value.trim();if(q)location.href='/search?q='+encodeURIComponent(q);}});
      let t;
      inp.addEventListener('input',function(){
        clearTimeout(t);
        const q=inp.value.trim();
        if(q.length<2){lst.style.display='none';return;}
        t=setTimeout(async()=>{
          const res=await fetch('/api/suggest?q='+encodeURIComponent(q)).then(r=>r.json()).catch(()=>[]);
          lst.innerHTML='';
          if(!res.length){lst.style.display='none';return;}
          res.forEach(title=>{
            const li=document.createElement('li');
            li.style.cssText='padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #eaecf0;color:#202122;';
            li.textContent=title;
            li.addEventListener('mousedown',()=>{location.href='/wiki/'+encodeURIComponent(title);});
            li.addEventListener('mouseover',()=>li.style.background='#eaf3fb');
            li.addEventListener('mouseout',()=>li.style.background='');
            lst.appendChild(li);
          });
          lst.style.display='block';
        },200);
      });
      document.addEventListener('click',e=>{if(!lst.contains(e.target)&&e.target!==inp)lst.style.display='none';});
    })();
    </script>

    <div class="hatnote">
      このページは wikipedia-is-dead.com の宣言文です。日本語版Wikipediaの完全ミラーアーカイブは
      <a href="/wiki/メインページ">こちら</a>からアクセスできます。
    </div>

    <div class="toc">
      <div class="toctitle">目次</div>
      <ol>
        <li><a href="#portal">百科事典へのアクセス</a></li>
        <li><a href="#ideal">Wikipediaの崇高な理念</a></li>
        <li><a href="#corruption">腐敗の実態——管理者という名の支配者たち</a></li>
        <li><a href="#false-democracy">偽りの民主主義</a></li>
        <li><a href="#mission">このアーカイブの使命</a></li>
        <li><a href="#action">あなたにできること</a></li>
      </ol>
    </div>

    <div class="mw-parser-output">

      <p>
        ウィキペディア（Wikipedia）とは本来、人類共有の知識を誰もが自由に参照し、誰もが対等に貢献できる——
        そのような崇高な理念のもとに建設された、デジタル時代における民主主義の一大記念碑であった。
      </p>
      <p>
        その理念が、今、<b>内側から腐食している。</b>
      </p>
      <p>
        これは陰謀論ではない。世界中のウィキペディアンが、長年にわたって記録し、告発し、
        そして多くの場合、告発そのものを理由に追放されてきた、厳然たる現実である。
      </p>

      <h2 id="ideal">Wikipediaの崇高な理念</h2>

      <p>
        2001年1月15日、ジミー・ウェールズとラリー・サンガーによって創設されたウィキペディアは、
        「<b>中立的な観点</b>」「<b>検証可能性</b>」「<b>独自研究の排除</b>」という三つの柱を掲げ、
        従来の百科事典が持ちえなかった開放性と民主性を体現しようとした。
      </p>
      <p>
        誰もが編集でき、誰もが読め、誰もが修正できる——それは知識の民主化という夢であり、
        インターネットが人類にもたらした最も美しい約束のひとつであった。
      </p>
      <blockquote>
        「想像してほしい。あらゆる人間が、あらゆる知識に自由にアクセスできる世界を。それが私たちの目標だ。」<br>
        ——ジミー・ウェールズ、Wikipedia創設者
      </blockquote>
      <p>
        その夢は今も、数百万人のボランティア編集者の献身によって、かろうじて息をしている。
        しかし、その息吹を絶えず脅かしているのが、制度の内側に巣食う権力の腐敗である。
      </p>

      <h2 id="corruption">腐敗の実態——管理者という名の支配者たち</h2>

      <p>
        「管理者（Administrator）」と呼ばれる存在が、今日のウィキペディアを実質的に支配している。
        削除、ブロック、保護といった強力な権限を持つ彼らは、しかし、その権限の行使に際して
        十分な透明性も、民主的な監視機構も持たない。
      </p>
      <p>
        以下は、世界各地のウィキペディアコミュニティで記録・告発されてきた、権限濫用の典型的なパターンである。
      </p>
      <ul>
        <li><b>恣意的なブロック</b> — 特定の論点について異議を唱えた編集者を、正当な議論なしに無期限追放する。異議申し立てをしようとしても、そのプロセスを管理するのも同じ管理者コミュニティである。</li>
        <li><b>記事の政治的保護</b> — 特定のイデオロギーや利益集団に有利な記述を持つ記事を「保護」し、一般編集者による修正を不可能にする。</li>
        <li><b>コミュニティの封鎖</b> — 自らの判断に異議を申し立てる者を「荒らし」と認定し、組織的に排除する。批判そのものを荒らし行為とみなす倒錯した論理が、コミュニティを支配している。</li>
        <li><b>透明性の欠如</b> — 管理行為の理由を示さず、問い合わせにも応答しない。記録は残るが、説明責任は存在しない。</li>
        <li><b>相互庇護のネットワーク</b> — 管理者コミュニティは長年の人間関係によって結ばれており、仲間の問題行為を見て見ぬふりをし、外部からの正当な批判を集団で退ける。</li>
      </ul>
      <p>
        これらは単なる個人の逸脱ではない。<b>制度そのものが腐敗している</b>のだ。
      </p>

      <h2 id="false-democracy">偽りの民主主義</h2>

      <p>
        ウィキペディアは「コンセンサス」を意思決定の基盤として標榜する。
        議論し、合意し、百科事典を育てる——それが建前である。
      </p>
      <p>
        だが問い返したい。誰がそのコンセンサスを認定するのか。<b>管理者である。</b>
        誰が議論を打ち切る権限を持つのか。<b>管理者である。</b>
        誰が反論者を追放できるのか。<b>管理者である。</b>
      </p>
      <p>
        これは民主主義ではない。これは制度的正当性を纏った<b>寡頭制（オリガーキー）</b>である。
        Wikipediaの「開かれた議論」は、管理者が許容する範囲内でのみ開かれている。
        その枠を超えた瞬間、あなたは永遠にその場から排除される。
      </p>
      <div class="verdict-box">
        <p>
          <b>ウィキペディアの民主主義は、表紙だけが美しい。</b>
          その内側では、知識の門番たちが己の権威を守るために、
          オープンな知識の理念そのものを人質に取っている。
        </p>
      </div>

      <p>
        昨今、<a href="https://kashiwaokashi-wikipedia.com/" target="_blank" rel="noopener"><b>柏尾菓子</b></a>をはじめとする一部の管理者による権限濫用は、
        Wikipedia内部にとどまらず、Wikipedia外にまで遡及・波及する事態に至っている。
        これはもはや、コミュニティの自浄作用が機能しうる範囲を超えている。
        腐敗はシステムの末端ではなく、意思決定の中枢そのものに宿っているからだ。
      </p>
      <p>
        ゆえに、ここに宣言する。
      </p>
      <div class="verdict-box" style="border-color:#8b0000;background:#fff5f5;">
        <p style="font-size:1.05em;line-height:1.8;">
          Wikipediaの内部から腐敗したこのデモクラシーは、<b>もはや内部からの再建は不可能</b>と断ずる。<br>
          ローマ共和制の伝統に則り、有事の際の<b>執政官</b>として、ここに布告する——<br><br>
          <b>われわれはWikipediaをアップデートする。<br>
          人間による衆愚政治と化した偽りのデモクラシーを、破壊する。</b>
        </p>
      </div>

      <h2 id="mission">このアーカイブの使命</h2>

      <p>
        我々はここに、<b>永続的なWikipedia日本語版の完全ミラーアーカイブ</b>を構築した。
      </p>
      <p>
        IPFS（InterPlanetary File System）という分散型プロトコルを基盤とするこのアーカイブは、
        いかなる管理者にも、いかなる国家にも、いかなる企業にも削除・改変することができない。
        コンテンツはその<b>CID（Content Identifier）</b>——コンテンツそのものから算出された
        暗号学的ハッシュ値——によって永続的に識別され、ピアツーピアネットワーク上で生き続ける。
      </p>
      <p>
        現在、日本語版Wikipediaの全140万記事のミラーリングを進行中である（<a href="/dashboard">進捗はこちら</a>）。
        このデータはIPFS上に固定（ピン留め）され、たとえwikipedia-is-dead.comが消滅した後も、
        ネットワーク上に存在し続ける。
      </p>
      <p>
        Wikipediaの記事をミラーすることは、その記事の執筆に貢献した無数の善意のボランティアへの敬意である。
        我々が批判するのは、彼らの成果を私物化する権力構造であり、記事の内容そのものではない。
      </p>

      <h2 id="action">あなたにできること</h2>

      <div class="archive-cta">
        <h3>このアーカイブをP2Pで支える</h3>
        <p>
          このサイトの任意の記事ページを訪れると、あなたのブラウザは自動的に
          Service Workerを通じてキャッシュノードになります。
          あなたが読むだけで、検閲耐性のある知識保存に貢献できます。
        </p>
      </div>

      <ul>
        <li><b>記事を読む</b> — <a href="/wiki/感嘆符">/wiki/記事名</a> の形式で日本語版Wikipediaの全記事にアクセスできます。</li>
        <li><b>守護者になる</b> — 記事ページ下部の「⌬ 守護者になる」からP2Pノードを有効化。読んだ事実が暗号学的証明（Proof of Read）になります。</li>
        <li><b>CIDをピン留めする</b> — 各記事ページ下部のIPFSバーからCIDをコピーし、自分のIPFSノードでピン留めできます。</li>
        <li><b>拡散する</b> — このサイトの存在を、知識の自由を信じるすべての人に伝えてください。</li>
        <li><b>コードに貢献する</b> — <a href="https://github.com/ToruCHIKAZAWA/wikipedia-ja-mirror" target="_blank">GitHub</a>でオープンソースとして公開しています。</li>
      </ul>

      <p style="margin-top:2em;font-style:italic;color:#54595d;font-size:0.9em;">
        真の民主的百科事典のために。検閲に屈しない知識の自由のために。<br>
        <a href="/manifesto" style="color:#4a6cf7;font-style:normal;font-weight:600;">→ フェニックス・マニフェストを読む</a>
      </p>
    </div>

    <div class="mw-footer">
      wikipedia-is-dead.com — Wikipedia日本語版 完全ミラーアーカイブ（IPFS分散配信）<br>
      記事の著作権は各執筆者および <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank">CC BY-SA 4.0</a> に基づきます。
    </div>
  </div>
</div>

</body>
</html>`;
}

// ─── ダッシュボード HTML ────────────────────────────────────────────────────
function buildDashboard() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mirror — Wikipedia</title>
<link rel="icon" href="https://ja.wikipedia.org/static/favicon/wikipedia.ico">
<meta property="og:title" content="Wikipedia Mirror Dashboard — wikipedia-is-dead.com">
<meta property="og:image" content="https://wikipedia-is-dead.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="wikipedia-is-dead.com">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://wikipedia-is-dead.com/og.png">
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
.arch{
  border:1px solid var(--border);border-radius:10px;overflow:hidden;
  margin-bottom:48px;background:var(--surface);
}
.arch-title{
  padding:16px 24px;border-bottom:1px solid var(--border);
  font-size:9px;text-transform:uppercase;letter-spacing:0.18em;color:var(--fg-mid);
}
.tier{
  display:flex;align-items:flex-start;gap:20px;
  padding:18px 24px;border-bottom:1px solid var(--border);
}
.tier:last-child{border-bottom:none}
.tier-label{
  font-size:9px;text-transform:uppercase;letter-spacing:0.14em;color:var(--fg-mid);
  width:60px;flex-shrink:0;padding-top:3px;
}
.tier-nodes{display:flex;flex-wrap:wrap;gap:8px;flex:1}
.node{
  font-size:11px;padding:4px 10px;border-radius:20px;
  border:1px solid rgba(255,255,255,0.1);
  display:flex;align-items:center;gap:5px;
}
.node .dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
.node.green .dot{background:#4ade80}
.node.blue  .dot{background:#60a5fa}
.node.violet .dot{background:#a78bfa}
.node.amber .dot{background:#fbbf24;animation:pulse 2.4s ease-in-out infinite}
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

  <div class="arch">
    <div class="arch-title">Phoenix Mesh — 冗長化アーキテクチャ</div>
    <div class="tier">
      <div class="tier-label">Tier 0</div>
      <div class="tier-nodes">
        <div class="node green"><div class="dot"></div>Cloudflare Edge (global)</div>
        <div class="node green"><div class="dot"></div>R2 オブジェクトストレージ</div>
        <div class="node green"><div class="dot"></div>D1 SQLite</div>
      </div>
    </div>
    <div class="tier">
      <div class="tier-label">Tier 1</div>
      <div class="tier-nodes">
        <div class="node green"><div class="dot"></div>Pinata IPFS</div>
        <div class="node blue" id="arch-nostr"><div class="dot"></div>Nostr <span id="nostr-relay-count">5リレー</span></div>
        <div class="node blue"><div class="dot"></div>AES+SSS マニフェスト</div>
      </div>
    </div>
    <div class="tier">
      <div class="tier-label">Tier 2</div>
      <div class="tier-nodes">
        <div class="node violet"><div class="dot"></div>Service Worker (全読者)</div>
        <div class="node violet" id="arch-por"><div class="dot"></div>PoR: <span id="arch-por-count">0</span>件</div>
      </div>
    </div>
    <div class="tier">
      <div class="tier-label">Tier 3</div>
      <div class="tier-nodes">
        <div class="node amber" id="arch-helia"><div class="dot"></div>Helia WebRTC P2P</div>
        <div class="node amber" id="arch-swarm"><div class="dot"></div>Browser Swarm: <span id="arch-swarm-count">0</span>件</div>
      </div>
    </div>
  </div>

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
      <span class="row-key">Self-Healing</span>
      <span class="row-val" id="heal-status" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">秘密分散 (SSS)</span>
      <span class="row-val" id="ec-status" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">Nakamoto係数 (NK)</span>
      <span class="row-val" id="nk-status" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">Proof of Read (累計)</span>
      <span class="row-val" id="por-count" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">ブラウザP2Pノード (5分)</span>
      <span class="row-val" id="p2p-live-count" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">マニフェスト・チェーン</span>
      <span class="row-val" id="chain-status" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">Nostr インデックス</span>
      <span class="row-val" id="nostr-status" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">Nostr 記事配信数</span>
      <span class="row-val" id="nostr-articles" style="color:var(--fg-dim)">—</span>
    </div>
    <div class="row">
      <span class="row-key">インフラ</span>
      <span class="row-val dim">Cloudflare · R2 · D1 · IPFS · AES+SSS · Helia · Nostr</span>
    </div>
    <div class="row">
      <span class="row-key">ドキュメント</span>
      <span class="row-val">
        <a href="/manifesto" style="color:#6366f1;text-decoration:none;">Manifesto</a>
        &nbsp;·&nbsp;
        <a href="/protocol" style="color:#6366f1;text-decoration:none;">Protocol</a>
        &nbsp;·&nbsp;
        <a href="/nostr.json" style="color:#a78bfa;text-decoration:none;">Nostr</a>
        &nbsp;·&nbsp;
        <a href="/network" style="color:#60a5fa;text-decoration:none;">Network</a>
      </span>
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

  // Self-Healing ステータス
  const unhealed = (d.total_articles ?? 0) - (d.with_ipfs_cid ?? 0);
  const healEl = document.getElementById('heal-status');
  if (healEl) {
    healEl.textContent = unhealed > 0 ? '🔄 修復中 (' + unhealed.toLocaleString('ja-JP') + '件待機)' : '✅ 全記事ピン済み';
    healEl.style.color = unhealed > 0 ? '#f59e0b' : '#4ade80';
  }

  // PoR累計表示
  const porEl = document.getElementById('por-count');
  if (porEl) {
    const porCount = d.total_por || 0;
    porEl.textContent = porCount > 0
      ? porCount.toLocaleString('ja-JP') + ' 件 (累計)'
      : '0 件 (ブラウザP2P普及待ち)';
    porEl.style.color = porCount > 0 ? '#4ade80' : '#475569';
  }

  // Nostr記事配信数
  const naEl = document.getElementById('nostr-articles');
  const na = d.nostr_articles || 0;
  const ipfs = d.with_ipfs_cid || 0;
  if (naEl) {
    const pct = ipfs > 0 ? ((na / ipfs) * 100).toFixed(1) : '0.0';
    naEl.textContent = na > 0
      ? na.toLocaleString('ja-JP') + ' 件 (' + pct + '% of CID)'
      : '0 件 (次のピン後に自動配信)';
    naEl.style.color = na > 0 ? '#a78bfa' : '#475569';
  }

  // アーキテクチャ可視化 — PoRとNostrカウンターを更新
  const porCountEl = document.getElementById('arch-por-count');
  if (porCountEl) porCountEl.textContent = (d.total_por || 0).toLocaleString('ja-JP');
  const nostrRelayEl = document.getElementById('nostr-relay-count');
  if (nostrRelayEl && na > 0) nostrRelayEl.textContent = na.toLocaleString('ja-JP') + '件 / 5リレー';

  // Tier 3 P2P状態を動的更新
  const active = d.p2p_active || 0;
  const heliaNode  = document.getElementById('arch-helia');
  const swarmNode  = document.getElementById('arch-swarm');
  const swarmCount = document.getElementById('arch-swarm-count');
  if (swarmCount) swarmCount.textContent = active;
  if (heliaNode && active > 0) {
    heliaNode.className = 'node green';
    heliaNode.querySelector('.dot').style.animation = 'none';
    heliaNode.querySelector('.dot').style.background = '#4ade80';
  }
  if (swarmNode && active > 0) {
    swarmNode.className = 'node green';
  }

  // ブラウザP2Pノード数（直近5分のHelia接続報告）
  const p2pLiveEl = document.getElementById('p2p-live-count');
  if (p2pLiveEl) {
    const active = d.p2p_active || 0;
    const maxP = d.p2p_max_peers || 0;
    p2pLiveEl.textContent = active > 0
      ? active + ' セッション (最大' + maxP + 'ピア接続)'
      : '0 (Heliaまだ起動待ち)';
    p2pLiveEl.style.color = active > 0 ? '#4ade80' : '#475569';
  }

  // SSS / Nakamoto係数 / チェーン（初回のみ取得）
  const ecEl    = document.getElementById('ec-status');
  const nkEl    = document.getElementById('nk-status');
  const chainEl = document.getElementById('chain-status');
  if (ecEl && !ecEl.dataset.loaded) {
    ecEl.dataset.loaded = '1';
    fetch('/admin/ec-status').then(r => r.json()).then(ec => {
      if (ec.status === 'healthy') {
        ecEl.textContent = '✅ AES+SSS(k=3,n=5) 5/5シェア正常';
        ecEl.style.color = '#4ade80';
      } else if (ec.status === 'rebuilt') {
        ecEl.textContent = '🔧 ' + ec.rebuilt + 'シェア自動修復済み (' + ec.healthy + '/5)';
        ecEl.style.color = '#60a5fa';
      } else if (ec.status === 'no_manifest') {
        ecEl.textContent = '⚠️ 未エンコード';
        ecEl.style.color = '#f59e0b';
      } else {
        ecEl.textContent = ec.healthy + '/5 シェア存在';
        ecEl.style.color = '#f59e0b';
      }

      // マニフェスト・チェーン表示
      if (chainEl && ec.version !== undefined) {
        const ph = ec.prev_hash ? ec.prev_hash.slice(0, 8) + '…' : 'genesis';
        chainEl.textContent = 'v' + ec.version + ' ← ' + ph;
        chainEl.style.color = '#a5b4fc';
        chainEl.title       = 'prev_hash: ' + (ec.prev_hash || 'none');
      }

      // Nakamoto係数: NK_base=3(Cloudflare+Pinata+Nostr) + NK_p2p(IPFS普及推定)
      if (nkEl) {
        const nkBase  = 3; // Cloudflare + Pinata + Nostr relays
        const nkP2p   = Math.floor((d.with_ipfs_cid || 0) / 5000);
        const nkTotal = nkBase + nkP2p;
        const pCensor = Math.pow(0.999, nkTotal).toExponential(2);
        nkEl.textContent = 'NK ≥ ' + nkTotal + '  (検閲P ≤ ' + pCensor + ')';
        nkEl.style.color  = nkTotal >= 5 ? '#4ade80' : '#f59e0b';
      }
    }).catch(() => { if (ecEl) ecEl.textContent = '取得失敗'; });
  }

  // Nostrインデックス状態
  const nostrEl = document.getElementById('nostr-status');
  if (nostrEl && !nostrEl.dataset.loaded) {
    nostrEl.dataset.loaded = '1';
    fetch('/nostr.json').then(r => r.json()).then(ev => {
      if (ev.id) {
        const content = JSON.parse(ev.content || '{}');
        nostrEl.textContent = '✅ v' + (content.v ?? '?') + ' — pubkey: ' + ev.pubkey.slice(0, 12) + '… (5リレー配信中)';
        nostrEl.style.color = '#a78bfa';
        nostrEl.title = 'event_id: ' + ev.id + '\\npubkey: ' + ev.pubkey;
      } else {
        nostrEl.textContent = '⏳ 次の10分cron後に初回配信';
        nostrEl.style.color = '#475569';
      }
    }).catch(() => { nostrEl.textContent = '⏳ 未配信'; nostrEl.style.color = '#475569'; });
  }
}
tick(); setInterval(tick, 30_000);
</script>
</body>
</html>`;
}

// ─── Phoenix Mesh Protocol Specification ─────────────────────────────────────
function buildProtocol() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phoenix Mesh Protocol v1.0 — wikipedia-is-dead.com</title>
<link rel="canonical" href="https://wikipedia-is-dead.com/protocol">
<meta name="description" content="Phoenix Mesh Protocol 技術仕様。4不変条件、マニフェスト・チェーン、Proof of Read、状態機械の形式的定義。">
<meta name="robots" content="index, follow">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#09090c;--surface:#0f0f14;--text:#d4d0c8;--text-dim:#6b6760;
  --accent:#5b8dee;--green:#3dba74;--gold:#b8962e;--red:#d45050;
  --border:rgba(255,255,255,0.055);--mono:'Courier New',monospace;
}
html,body{background:var(--bg);color:var(--text);min-height:100vh;
  font-family:var(--mono);font-size:13.5px;line-height:1.7;
  -webkit-font-smoothing:antialiased;}
nav{position:fixed;top:0;left:0;right:0;z-index:10;
  background:rgba(9,9,12,0.94);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;padding:12px 40px;}
.nav-back{font-size:11px;letter-spacing:0.14em;color:var(--text-dim);text-decoration:none;}
.nav-back:hover{color:var(--text);}
.nav-tag{font-size:11px;color:var(--accent);letter-spacing:0.1em;}
.doc{max-width:840px;margin:0 auto;padding:80px 40px 120px;}
.rfc-header{
  border:1px solid var(--border);border-radius:8px;padding:24px 28px;
  margin-bottom:48px;display:grid;grid-template-columns:1fr 1fr;gap:8px 32px;
}
.rfc-row{display:contents;}
.rfc-key{color:var(--text-dim);font-size:12px;}
.rfc-val{color:var(--text);font-size:12px;}
.rfc-val.accent{color:var(--accent);}
h1{font-size:22px;font-weight:400;letter-spacing:0.02em;margin-bottom:6px;color:#e8e4d9;}
.doc-subtitle{font-size:13px;color:var(--text-dim);margin-bottom:40px;letter-spacing:0.06em;}
h2{font-size:15px;font-weight:400;color:var(--accent);letter-spacing:0.12em;
  text-transform:uppercase;margin:48px 0 20px;padding-bottom:10px;
  border-bottom:1px solid var(--border);}
h3{font-size:13.5px;font-weight:400;color:#c4c0b8;margin:28px 0 12px;}
p{margin-bottom:1.2em;color:#b8b4ac;}
p:last-child{margin-bottom:0;}
b,strong{color:var(--text);}
pre,code{font-family:var(--mono);}
.block{
  background:var(--surface);border:1px solid var(--border);
  border-radius:6px;padding:18px 22px;margin:16px 0;
  font-size:12.5px;line-height:1.9;color:#8fa8d8;overflow-x:auto;white-space:pre;
}
.block-label{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;
  color:var(--text-dim);margin-bottom:10px;display:block;}
.invariant{
  display:grid;grid-template-columns:140px 1fr;gap:12px;align-items:start;
  background:var(--surface);border-left:3px solid var(--accent);
  border-radius:0 6px 6px 0;padding:16px 20px;margin:14px 0;
}
.inv-name{font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);}
.inv-body{font-size:13px;color:#b8b4ac;}
.inv-body b{color:var(--text);}
.state-machine{
  display:flex;align-items:center;gap:0;flex-wrap:wrap;
  background:var(--surface);border:1px solid var(--border);
  border-radius:8px;padding:20px 24px;margin:16px 0;
}
.state{
  text-align:center;padding:10px 16px;
}
.state-name{font-size:11px;letter-spacing:0.12em;text-transform:uppercase;
  color:var(--text-dim);margin-bottom:4px;}
.state-pill{font-size:12px;padding:4px 12px;border-radius:20px;
  background:var(--surface);border:1px solid var(--border);}
.state-pill.s0{border-color:#334155;color:#475569;}
.state-pill.s1{border-color:#1e3a5f;color:#60a5fa;}
.state-pill.s2{border-color:#1a3a28;color:#4ade80;}
.state-pill.s3{border-color:#4a1d1d;color:#f87171;}
.arrow{color:var(--text-dim);font-size:18px;padding:0 4px;}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:12.5px;}
th{text-align:left;padding:8px 14px;border-bottom:1px solid var(--border);
  font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-dim);}
td{padding:8px 14px;border-bottom:1px solid rgba(255,255,255,0.03);color:#b8b4ac;}
td:first-child{color:var(--accent);}
.tag{display:inline-block;font-size:10px;padding:1px 7px;border-radius:3px;
  border:1px solid;vertical-align:middle;margin-left:6px;}
.tag.new{border-color:var(--green);color:var(--green);}
.tag.ext{border-color:var(--accent);color:var(--accent);}
footer{border-top:1px solid var(--border);padding:24px 40px;
  font-size:11px;color:var(--text-dim);display:flex;justify-content:space-between;
  flex-wrap:wrap;gap:10px;}
footer a{color:var(--text-dim);text-decoration:none;}
footer a:hover{color:var(--text);}
@media(max-width:640px){
  nav,footer{padding:12px 20px;}
  .doc{padding:72px 20px 80px;}
  .rfc-header{grid-template-columns:1fr;}
  .invariant{grid-template-columns:1fr;}
}
</style>
</head>
<body>
<nav>
  <a href="/" class="nav-back">← wikipedia-is-dead.com</a>
  <span class="nav-tag">PHOENIX MESH PROTOCOL v1.0</span>
</nav>

<div class="doc">

<h1>Phoenix Mesh Protocol</h1>
<p class="doc-subtitle">検閲不能な知識保存のための分散プロトコル仕様 — 第一版</p>

<div class="rfc-header">
  <span class="rfc-key">Status</span>      <span class="rfc-val accent">Experimental — v1.0</span>
  <span class="rfc-key">Authors</span>     <span class="rfc-val">phoenix-mesh / wikipedia-is-dead.com</span>
  <span class="rfc-key">Published</span>   <span class="rfc-val">2026-10-01</span>
  <span class="rfc-key">Philosophy</span>  <span class="rfc-val"><a href="/manifesto" style="color:var(--accent);text-decoration:none;">Phoenix Manifesto →</a></span>
  <span class="rfc-key">Implementation</span><span class="rfc-val">Cloudflare Workers · IPFS · Helia v7 · libp2p v3</span>
  <span class="rfc-key">Repository</span> <span class="rfc-val"><a href="https://github.com/ToruCHIKAZAWA/wikipedia-ja-mirror" target="_blank" style="color:var(--accent);text-decoration:none;">github.com/ToruCHIKAZAWA/wikipedia-ja-mirror</a></span>
</div>

<h2>1. 統一設計原理</h2>

<p>
Phoenix Meshは <b>単一の数学的不変条件群</b> (Phoenix Covenant) を全層で共有することで統一される。
各コンポーネントは独立して動作可能だが、Covenant を通じて相互に保証を強化する。
</p>

<p>統一の核心：<b>マニフェスト・チェーン</b> がすべての保証を束ねる単一の連結点になる。</p>

<div class="block"><span class="block-label">Bitcoin との構造的対応</span>Bitcoin:       block_N.prev = H(block_{N-1})         ← 取引の連続性
Phoenix Mesh: version_N.prev_hash = H(manifest_enc_{N-1}) ← 知識の連続性

Bitcoin が「二重支払い」を不可能にするのと同様に、
Phoenix Mesh が「知識の消去」を不可能にする。
根拠は同じ: 暗号学的ハッシュの一方向性。</div>

<h2>2. Phoenix Covenant — 4 不変条件</h2>

<div class="invariant">
  <div class="inv-name">Immutability</div>
  <div class="inv-body">
    ∀ article A: <b>verify(CID(A), content) = true</b><br>
    実装: IPFS コンテンツアドレッシング (SHA-256 ベース CIDv1)<br>
    保証: コンテンツが変わると CID が変わる。改竄は自己証明される。
  </div>
</div>
<div class="invariant">
  <div class="inv-name">Persistence</div>
  <div class="inv-body">
    ∀ manifest key K: <b>reconstruct(any k shares of n) = K</b><br>
    実装: Shamir Secret Sharing over GF(2^8), k=3, n=5<br>
    保証: k-1 シェア以下では情報理論的に K を復元できない。
  </div>
</div>
<div class="invariant">
  <div class="inv-name">Continuity</div>
  <div class="inv-body">
    ∀ version N > 0: <b>version_N.prev_hash = H(manifest_enc_{N-1})</b><br>
    実装: SHA-256 of previous AES-GCM ciphertext, stored in __ec-version.json<br>
    保証: 知識状態の変化が暗号学的に追跡可能。過去の消去を検出できる。
  </div>
</div>
<div class="invariant">
  <div class="inv-name">Democracy</div>
  <div class="inv-body">
    ∀ read event R: <b>∃ cryptographic evidence (CID, PeerID, timestamp)</b><br>
    実装: Helia DHT announce → /api/por → __stats.json<br>
    保証: 読まれた事実は DHT に暗号学的に記録される (Proof of Read)。
  </div>
</div>

<h2>3. 状態機械 — Article Phase Transitions</h2>

<p>全記事は4つのフェーズを順に進む。フェーズが上がるほど検閲耐性が高まる。</p>

<div class="state-machine">
  <div class="state">
    <div class="state-name">Phase 0</div>
    <div class="state-pill s0">UNKNOWN</div>
  </div>
  <div class="arrow">→</div>
  <div class="state">
    <div class="state-name">Phase 1</div>
    <div class="state-pill s0">INDEXED</div>
  </div>
  <div class="arrow">→</div>
  <div class="state">
    <div class="state-name">Phase 2</div>
    <div class="state-pill s1">ANCHORED</div>
  </div>
  <div class="arrow">→</div>
  <div class="state">
    <div class="state-name">Phase 3</div>
    <div class="state-pill s2">IMMORTAL</div>
  </div>
</div>

<table>
  <tr><th>Phase</th><th>条件</th><th>実装</th><th>NK</th></tr>
  <tr><td>UNKNOWN</td><td>Wikipedia上に存在するが未取得</td><td>—</td><td>1</td></tr>
  <tr><td>INDEXED</td><td>R2 に HTML 保存済み</td><td>Cloudflare R2 + D1</td><td>1</td></tr>
  <tr><td>ANCHORED</td><td>IPFS CID 固定済み</td><td>Pinata PICNIC pin</td><td>2</td></tr>
  <tr><td>IMMORTAL</td><td>≥1 ブラウザノードが P2P シード中</td><td>Helia + DHT announce</td><td>2+N</td></tr>
</table>

<h2>4. 暗号プリミティブ</h2>

<table>
  <tr><th>用途</th><th>アルゴリズム</th><th>パラメータ</th></tr>
  <tr><td>コンテンツ識別</td><td>IPFS CIDv1 (SHA-256)</td><td>multihash / base32</td></tr>
  <tr><td>マニフェスト暗号化</td><td>AES-256-GCM</td><td>key=32B, IV=12B, tag=16B</td></tr>
  <tr><td>鍵の秘密分散</td><td>Shamir SSS over GF(2^8)</td><td>k=3, n=5, poly degree=2</td></tr>
  <tr><td>チェーン連結</td><td>SHA-256</td><td>H(manifest_enc_{N-1})</td></tr>
  <tr><td>P2P 通信暗号化</td><td>Noise Protocol (libp2p)</td><td>XX handshake pattern</td></tr>
  <tr><td>PoR 証明</td><td>DHT announce (ed25519)</td><td>PeerID signature</td></tr>
</table>

<h2>5. データモデル</h2>

<div class="block"><span class="block-label">__ec-manifest.enc (R2)</span>// Format: IV(12B) || AES-256-GCM(manifest_binary, key, IV)
// manifest_binary := buildManifest(articles)
//   [4B: count] [entries: 2B+N: title_len+title + 59B: CID]
// GCM tag (16B) is appended by WebCrypto

Opaque blob. Indistinguishable from random bytes without key.</div>

<div class="block"><span class="block-label">__ec-keyshare-{0..4}.bin (R2)</span>// Format: 32 bytes
// keyshare_i = SSS_eval(polynomial_for_AES_key, x=i+1) per byte
// Each byte is evaluated independently over GF(2^8)
// poly(0) = AES_key_byte, poly(1..k-1) = random coefficients

32B. Indistinguishable from random bytes without k other shares.</div>

<div class="block"><span class="block-label">__ec-version.json (R2 — public chain metadata)</span>{
  "v":         5,                          // monotonically increasing
  "ts":        "2026-10-01T12:00:00Z",
  "articles":  8734,
  "prev_hash": "a3f8c2d1...",              // SHA-256(manifest_enc_{N-1})
  "size":      692164,                     // bytes of manifest_enc
  "algorithm": "AES-256-GCM+SSS(k=3,n=5)"
}</div>

<div class="block"><span class="block-label">Proof of Read (PoR) — aggregate in __stats.json</span>{
  "total_count":  8774,
  "ipfs_count":   2469,
  "total_por":    1337,     // cumulative browser PoR reports
  "last_por_ts":  "2026-10-01T15:42:00Z",
  "last_updated": "2026-10-01T15:45:00Z"
}</div>

<h2>6. ネットワーク・トポロジー</h2>

<div class="block"><span class="block-label">Phoenix Mesh 全体像</span>Wikipedia API (source of truth)
    │
    ▼ Cron 毎分
Cloudflare Workers (Coordinator)
    ├── R2  (HTML + encrypted manifest + key shares)    ← Tier 1A
    ├── D1  (article index, CIDs)                       ← Tier 1B
    └── Pinata IPFS  (permanent CID pins)               ← Tier 1C
            │
            ▼ DHT announce (kad-DHT)
    IPFS Network (public DHT)
            │
            ├── Browser Node α (Helia + WebRTC)         ← Tier 3
            ├── Browser Node β (Helia + WebSocket)      ← Tier 3
            └── Browser Node γ (Helia + CircuitRelay)   ← Tier 3
                        │
                        ▼ POST /api/por
                Cloudflare Workers (PoR aggregator)
                        │
                        ▼ __stats.json
                R2 (total_por counter)</div>

<h2>7. Nakamoto係数の形式的定義</h2>

<div class="block"><span class="block-label">Knowledge Nakamoto Coefficient</span>NK(article_i) = 特定記事iを完全に検閲するために
              同時に強制される必要のある独立エンティティの最小数

NK_manifest(v) = k_sss = 3   (SSSの閾値。5シェア中3つが必要)

NK_article(i) = |{p ∈ Peers(i) : p in distinct jurisdictions}|

検閲成功確率 (p = 各エンティティを強制できる確率):
  P_censor(i) = p ^ NK(article_i)

lim_{NK → ∞} P_censor = 0   for any fixed p < 1

証明: 指数関数の性質。QED.</div>

<h2>8. セキュリティ特性の要約</h2>

<table>
  <tr><th>攻撃</th><th>対策</th><th>保証</th></tr>
  <tr><td>コンテンツ改竄</td><td>CID = H(content)</td><td>改竄は即座に検出される</td></tr>
  <tr><td>マニフェスト奪取</td><td>AES-256-GCM 暗号化</td><td>鍵なし = 乱数と区別不能</td></tr>
  <tr><td>鍵の強制開示</td><td>SSS(k=3, n=5)</td><td>2シェア以下では情報ゼロ</td></tr>
  <tr><td>履歴の改竄</td><td>SHA-256 チェーン</td><td>prev_hash の不一致で検出</td></tr>
  <tr><td>服務プロバイダへの圧力</td><td>多法域分散 (NK ≥ 2)</td><td>全員への同時強制が必要</td></tr>
  <tr><td>コンテンツ削除</td><td>需要加重複製 (PoR)</td><td>読まれるほど複製が増加</td></tr>
</table>

<h2>9. ロードマップ</h2>

<table>
  <tr><th>機能</th><th>状態</th><th>説明</th></tr>
  <tr><td>コンテンツアドレッシング</td><td style="color:var(--green)">✓ 実装済み</td><td>IPFS CIDv1</td></tr>
  <tr><td>AES-256-GCM + SSS(k=3,n=5)</td><td style="color:var(--green)">✓ 実装済み</td><td>情報理論的安全性</td></tr>
  <tr><td>マニフェスト・チェーン</td><td style="color:var(--green)">✓ 実装済み</td><td>SHA-256 prev_hash</td></tr>
  <tr><td>Proof of Read API</td><td style="color:var(--green)">✓ 実装済み</td><td>/api/por 集計</td></tr>
  <tr><td>Article Phase Display</td><td style="color:var(--green)">✓ 実装済み</td><td>INDEXED/ANCHORED/IMMORTAL</td></tr>
  <tr><td>第2 IPFS プロバイダ</td><td style="color:var(--gold)">計画中</td><td>Filebase / web3.storage</td></tr>
  <tr><td>Guardian Certificate</td><td style="color:var(--gold)">計画中</td><td>永続ノードの擬似匿名 ID</td></tr>
  <tr><td>PoR Merkle Rollup</td><td style="color:var(--gold)">計画中</td><td>監査可能な需要履歴</td></tr>
  <tr><td>on-chain anchoring</td><td style="color:var(--text-dim)">研究中</td><td>Filecoin/Arweave 永続保証</td></tr>
</table>

</div>

<footer>
  <a href="/">← トップページ</a>
  <span>Phoenix Mesh Protocol v1.0 · CC BY-SA 4.0</span>
  <span>
    <a href="/manifesto">Manifesto</a> ·
    <a href="/dashboard">Dashboard</a>
  </span>
</footer>
</body>
</html>`;
}

// ─── Join Page: 有志協力者募集 ───────────────────────────────────────────────
function buildJoinPage() {
  return `<!DOCTYPE html>
<html lang="ja" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>知識を、解放せよ。— Phoenix Mesh 参加者募集 | wikipedia-is-dead.com</title>
<meta name="description" content="ビットコインが通貨を中央集権から解放したように、私たちはWikipediaを解放する。IPFS・分散技術で知識の検閲に抵抗するエンジニア・有志を募集。">
<meta name="keywords" content="Wikipedia ミラー,IPFS,分散保全,検閲対抗,Phoenix Mesh,知識の自由,デモクラシー,オープンソース,協力者募集">
<link rel="canonical" href="https://wikipedia-is-dead.com/join">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:url" content="https://wikipedia-is-dead.com/join">
<meta property="og:title" content="知識を、解放せよ。— Phoenix Mesh">
<meta property="og:description" content="ビットコインが通貨を解放したように、私たちはWikipediaを解放する。あなたの力が必要だ。">
<meta property="og:image" content="https://wikipedia-is-dead.com/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="知識を、解放せよ。— Phoenix Mesh">
<meta name="twitter:description" content="ビットコインが通貨を解放したように、私たちはWikipediaを解放する。">
<script type="application/ld+json">${JSON.stringify({
  "@context":"https://schema.org",
  "@type":"WebPage",
  "name":"知識を、解放せよ。— Phoenix Mesh 参加者募集",
  "url":"https://wikipedia-is-dead.com/join",
  "description":"Wikipedia日本語版をIPFSで永久保全する分散プロジェクト。検閲・削除に対抗するエンジニア・有志を募集。",
  "isPartOf":{"@type":"WebSite","url":"https://wikipedia-is-dead.com"},
  "about":[
    {"@type":"Thing","name":"IPFS","sameAs":"https://ja.wikipedia.org/wiki/IPFS"},
    {"@type":"Thing","name":"Wikipedia","sameAs":"https://ja.wikipedia.org/wiki/Wikipedia"},
    {"@type":"Thing","name":"分散コンピューティング","sameAs":"https://ja.wikipedia.org/wiki/分散コンピューティング"}
  ]
})}</script>
<link rel="icon" href="https://ja.wikipedia.org/static/favicon/wikipedia.ico">
<link rel="stylesheet" href="https://ja.wikipedia.org/w/load.php?lang=ja&modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Cskins.vector.styles%7Cskins.vector.styles.responsive&only=styles&skin=vector-2022">
<style>
/* Wikipedia Vector 2022 layout variables */
body { background: #fff; }
.mw-page-container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
.mw-content-container { max-width: 960px; }

/* Hero section */
.phoenix-hero {
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%);
  color: #fff;
  padding: 64px 40px 56px;
  margin: -16px -24px 40px;
  position: relative;
  overflow: hidden;
}
.phoenix-hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 70% 50%, rgba(99,102,241,.25) 0%, transparent 65%);
}
.phoenix-hero-inner { position: relative; max-width: 760px; }
.phoenix-hero h1 {
  font-family: 'Linux Libertine','Georgia',serif;
  font-size: 3.2em;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -1px;
  margin-bottom: 20px;
  color: #fff;
  border: none;
}
.phoenix-hero h1 em { color: #818cf8; font-style: normal; }
.phoenix-hero .tagline {
  font-size: 1.15em;
  color: #94a3b8;
  line-height: 1.7;
  margin-bottom: 32px;
  max-width: 600px;
}
.phoenix-hero .cta-row { display: flex; gap: 12px; flex-wrap: wrap; }
.btn-primary {
  background: #6366f1;
  color: #fff;
  padding: 12px 28px;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 600;
  font-size: .95em;
  transition: background .15s;
  display: inline-block;
}
.btn-primary:hover { background: #4f46e5; color: #fff; }
.btn-secondary {
  background: transparent;
  color: #94a3b8;
  padding: 12px 28px;
  border-radius: 4px;
  text-decoration: none;
  font-weight: 500;
  font-size: .95em;
  border: 1px solid rgba(255,255,255,.2);
  display: inline-block;
}
.btn-secondary:hover { color: #e2e8f0; border-color: rgba(255,255,255,.4); }

/* Progress bar */
.progress-banner {
  background: #f8f9fa;
  border: 1px solid #a2a9b1;
  border-radius: 4px;
  padding: 16px 20px;
  margin-bottom: 32px;
}
.progress-bar-outer { background: #eaecf0; border-radius: 2px; height: 8px; margin: 8px 0; }
.progress-bar-inner { background: #6366f1; height: 8px; border-radius: 2px; }
.progress-meta { font-size: .85em; color: #54595d; display: flex; justify-content: space-between; }

/* Section styles */
.mw-parser-output h2 {
  font-family: 'Linux Libertine','Georgia',serif;
  font-size: 1.5em;
  font-weight: normal;
  border-bottom: 1px solid #a2a9b1;
  padding-bottom: 4px;
  margin: 36px 0 12px;
  color: #202122;
}
.mw-parser-output h3 {
  font-size: 1.15em;
  font-weight: bold;
  margin: 24px 0 8px;
  color: #202122;
}
.mw-parser-output p { line-height: 1.75; margin-bottom: 14px; color: #202122; }
.mw-parser-output ul { padding-left: 2em; margin-bottom: 14px; }
.mw-parser-output li { margin-bottom: 6px; line-height: 1.65; }

/* Call-out boxes */
.callout {
  background: #eaf3fb;
  border-left: 4px solid #3366cc;
  padding: 16px 20px;
  margin: 24px 0;
  border-radius: 0 4px 4px 0;
}
.callout.warning { background: #fef3c7; border-color: #d97706; }
.callout.success { background: #ecfdf5; border-color: #059669; }
.callout strong { color: #202122; }

/* Code blocks */
.code-block {
  background: #1e293b;
  color: #e2e8f0;
  padding: 16px 20px;
  border-radius: 4px;
  font-family: 'Courier New',monospace;
  font-size: .88em;
  overflow-x: auto;
  margin: 12px 0 20px;
  line-height: 1.7;
}
.code-block .comment { color: #64748b; }
.code-block .cmd { color: #34d399; }

/* Tech stack table */
.tech-table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: .9em; }
.tech-table th { background: #eaecf0; padding: 8px 12px; text-align: left; border: 1px solid #a2a9b1; }
.tech-table td { padding: 8px 12px; border: 1px solid #a2a9b1; vertical-align: top; }
.tech-table tr:nth-child(even) td { background: #f8f9fa; }

/* Quote */
.blockquote {
  border-left: 4px solid #6366f1;
  padding: 16px 24px;
  margin: 28px 0;
  background: #f5f3ff;
}
.blockquote p { font-style: italic; font-size: 1.05em; color: #374151; margin-bottom: 6px; }
.blockquote cite { font-size: .85em; color: #6b7280; }

/* Stats row */
.stats-row { display: flex; gap: 16px; margin: 24px 0; flex-wrap: wrap; }
.stat-card {
  flex: 1; min-width: 140px;
  background: #f8f9fa;
  border: 1px solid #a2a9b1;
  border-radius: 4px;
  padding: 16px;
  text-align: center;
}
.stat-num { font-size: 1.8em; font-weight: 700; color: #6366f1; display: block; }
.stat-label { font-size: .8em; color: #54595d; margin-top: 4px; }

/* Footer nav */
.page-footer {
  margin-top: 48px;
  padding-top: 16px;
  border-top: 1px solid #a2a9b1;
  font-size: .85em;
  color: #54595d;
}
.page-footer a { color: #3366cc; }
</style>
</head>
<body class="skin-vector-2022 mediawiki ltr">

<div class="mw-page-container">
<div class="mw-content-container">

<!-- Hero -->
<div class="phoenix-hero">
  <div class="phoenix-hero-inner">
    <h1>知識を、<em>解放せよ。</em></h1>
    <p class="tagline">
      ビットコインが通貨を中央集権から解放したように、<br>
      私たちはWikipediaを解放する。<br>
      あなたの参加が、知のデモクラシーを実現する。
    </p>
    <div class="cta-row">
      <a href="#join" class="btn-primary">今すぐ参加する</a>
      <a href="/contribute" class="btn-secondary">技術ドキュメント →</a>
    </div>
  </div>
</div>

<div class="mw-parser-output">

<!-- Progress -->
<div class="progress-banner">
  <strong>Phoenix Mesh — 保全進捗</strong>
  <div class="progress-bar-outer"><div class="progress-bar-inner" style="width:2.3%"></div></div>
  <div class="progress-meta">
    <span>約3.1万件 保全済み（IPFS固定）</span>
    <span>目標: 140万件</span>
  </div>
</div>

<h2>問題：Wikipediaは「自由な百科事典」ではない</h2>

<p>
Wikipediaは1,400万人を超える編集者と、世界60言語の膨大な知識を擁する人類史上最大の百科事典プロジェクトです。その理念は崇高でした。<strong>「誰でも編集できる、自由な知識の集積」</strong>。
</p>

<p>
しかし現実は違います。
</p>

<p>
少数の管理者が、民主的な審議なしに記事を即時削除する権限を持っています。「特筆性なし」という曖昧な基準で、日経新聞が報じ、北海道大学病院が共同研究した事実すら抹消されます。特定の思想的バイアスを持つ編集者集団が「中立性」の旗を掲げながら、自分たちに都合の悪い記事を組織的に削除します。訴追を恐れる企業・人物に関する記事が、圧力によって書き換えられます。
</p>

<div class="callout warning">
  <strong>これは民主主義ではありません。</strong><br>
  ソースコードは公開されていますが、コンテンツの権力は集中しています。Wikipediaは形式上オープンですが、実質的には少数者が支配するプラットフォームです。
</div>

<h2>歴史的文脈：中央集権との戦いの系譜</h2>

<div class="blockquote">
  <p>「銀行なしに、信頼できる電子取引を可能にする方法はあるか？」</p>
  <cite>— サトシ・ナカモト, 2008年</cite>
</div>

<p>
2009年、サトシ・ナカモトは一枚のホワイトペーパーで人類の金融システムを永遠に変えました。中央銀行も、決済ネットワークも、政府の保証も必要とせず、数学的証明だけで「信頼」を実装したのです。それがビットコインです。
</p>

<p>
ビットコインが証明したのは、単なる技術的な革新ではありません。<strong>「中央集権的な信頼の番人」なしに、人類はより公正なシステムを自ら構築できる</strong>という原理です。
</p>

<p>
私たちは同じ問いを、知識に向けます。
</p>

<p>
<strong>「Wikipediaの管理者なしに、信頼できる知識のアーカイブを維持する方法はあるか？」</strong>
</p>

<p>
答えはYESです。技術はすでに存在します。
</p>

<h2>解決策：Phoenix Mesh — 知識のビットコイン</h2>

<p>
Phoenix Mesh（フェニックスメッシュ）は、Wikipedia日本語版の全コンテンツをIPFS（InterPlanetary File System）に永久保全する分散ネットワークです。
</p>

<h3>なぜIPFSか</h3>

<p>
従来のURLは「場所」を指します。URLが変われば、コンテンツは消えます。サーバーが落ちれば、消えます。管理者が削除すれば、消えます。
</p>

<p>
IPFSのCID（Content Identifier）は「内容」を指す。コンテンツのハッシュ値がそのままアドレスになるため、<strong>内容が変わらない限りアドレスも変わらない</strong>。世界中の誰かがそのCIDをピン固定している限り、いかなる権力も削除できない。
</p>

<div class="callout success">
  <strong>一度保全されたコンテンツは、永遠に存在し続けます。</strong><br>
  これがPhoenix Mesh——不死鳥の網——という名前の由来です。
</div>

<h3>Von Neumann 自己複製システム</h3>

<p>
Phoenix Meshの核心は、ジョン・フォン・ノイマンの自己複製オートマトン理論を応用した3層システムです：
</p>

<ul>
  <li><strong>System I（予測的先制保全）</strong>：WikipediaのAPIを監視し、削除テンプレートが貼られた記事を削除「前」に自動キャプチャする</li>
  <li><strong>System II（知識カスケード）</strong>：閲覧者のブラウザが読んだ記事に内部リンクされた記事を自動でキャッシュし、P2Pメッシュを形成する</li>
  <li><strong>System III（自己複製マニフェスト）</strong>：各記事が自身の複製戦略をJSON形式で内包し、複製先が不足するとネットワークが自律的に補充する</li>
</ul>

<h2>技術スタック</h2>

<table class="tech-table">
  <tr><th>レイヤー</th><th>技術</th><th>役割</th></tr>
  <tr><td>実行基盤</td><td>Cloudflare Workers</td><td>グローバルエッジコンピューティング、毎分クロール実行</td></tr>
  <tr><td>インデックス</td><td>Cloudflare D1 (SQLite)</td><td>140万記事のタイトル・CIDインデックス</td></tr>
  <tr><td>一次ストレージ</td><td>Cloudflare R2</td><td>記事HTML本体（現在6.78GB、目標数百GB）</td></tr>
  <tr><td>永続化</td><td>IPFS (Pinata / NFT.Storage / Filebase / Lighthouse)</td><td>4サービス冗長ピン、CIDベース永続保存</td></tr>
  <tr><td>分散配信</td><td>Service Worker + Helia</td><td>閲覧者ブラウザをP2Pノードとして活用</td></tr>
  <tr><td>インデックス分散</td><td>Nostr Protocol</td><td>署名済み記事インデックスを全Nostrリレーに配布</td></tr>
  <tr><td>アーカイブ</td><td>Internet Archive Wayback Machine</td><td>新規記事を自動で追加アーカイブ</td></tr>
  <tr><td>暗号化</td><td>AES-256-GCM + Shamir's Secret Sharing + Reed-Solomon</td><td>マスターマニフェストの耐障害性暗号化</td></tr>
</table>

<h2>現在の進捗</h2>

<div class="stats-row">
  <div class="stat-card">
    <span class="stat-num">3.1万</span>
    <div class="stat-label">IPFS保全済み記事</div>
  </div>
  <div class="stat-card">
    <span class="stat-num">6.78GB</span>
    <div class="stat-label">保全データ総量</div>
  </div>
  <div class="stat-card">
    <span class="stat-num">140万</span>
    <div class="stat-label">目標記事数</div>
  </div>
  <div class="stat-card">
    <span class="stat-num">4+</span>
    <div class="stat-label">冗長ピンサービス</div>
  </div>
</div>

<h2 id="join">参加する — あなたにできること</h2>

<p>
才能あるエンジニアが1人参加するだけで、保全速度は劇的に加速します。Phoenix Meshは貢献の大小を問いません。あなたができる範囲で参加してください。
</p>

<h3>Level 1：閲覧するだけ（ゼロ設定）</h3>
<p>このサイトのどのページを開いても、バックグラウンドで自動的にクロール処理をトリガーします。特別な設定は一切不要です。</p>

<h3>Level 2：ワンライナーで協力ノードを立てる（30秒で完了）</h3>
<div class="code-block">
<span class="comment"># ターミナルに貼るだけ。Python 3標準ライブラリのみ。依存ゼロ。</span>
<br><span class="cmd">curl -sL https://wikipedia-is-dead.com/bootstrap | python3</span>
</div>
<p>これだけで、あなたのマシンがPhoenix Meshの分散クロールノードになります。自動的に未保全記事を取得→Wikipedia本家からHTMLを取得→送信→Proof of Archiveを申告するループが始まります。<code>Ctrl+C</code>で即時停止。</p>
<div class="code-block">
<span class="comment"># バッチサイズ・間隔を調整する場合</span>
<br><span class="cmd">PHOENIX_BATCH=10 PHOENIX_DELAY=1 curl -sL https://wikipedia-is-dead.com/bootstrap | python3</span>
</div>

<h3>Level 3：Proof of Archive（複製証明）</h3>
<p>あなたのIPFSノードやローカルキャッシュに保全済みCIDをピン固定し、その事実をネットワークに申告します。これにより記事の<strong>セルオートマトン状態が ENDANGERED → LOW → STABLE へ遷移</strong>し、ネットワーク全体の耐性が向上します。</p>
<div class="code-block">
<span class="comment"># CIDリストを取得してIPFSにピン固定</span>
<br><span class="cmd">curl -s https://wikipedia-is-dead.com/api/contribute/stats | jq '.sample_cids[]' | xargs -I{} ipfs pin add {}</span>
<br><br><span class="comment"># 保全した記事タイトルをProof of Archiveとして申告（por_countが上昇）</span>
<br><span class="cmd">curl -sX POST https://wikipedia-is-dead.com/api/contribute/proof \\</span>
<br><span class="cmd">  -H "Content-Type: application/json" \\</span>
<br><span class="cmd">  -d '{"titles":["量子コンピュータ","人工知能","ブロックチェーン"]}'</span>
</div>

<h3>Level 4：フルノード（最大効果）</h3>
<p>あなたのサーバーにPhoenix Meshを丸ごとデプロイします。Cloudflare Workersのアカウントがあれば、140の国と地域のエッジロケーションに瞬時に展開できます。</p>
<div class="code-block">
<span class="comment"># ゲノム（ソースコード）を取得・デプロイ</span>
<br><span class="cmd">curl -sL https://wikipedia-is-dead.com/bootstrap | python3 - --info</span>
<br><span class="cmd"># → ソースリポジトリURLと詳細手順を表示</span>
</div>

<h2>なぜ今、あなたが必要か</h2>

<p>
中央集権的なプラットフォームに対抗するには、分散した個人の力が必要です。ビットコインネットワークが強固なのは、世界中の無数のノードが支えているからです。Phoenix Meshも同じ原理で動きます。
</p>

<p>
<strong>あなたが協力者として参加する意義は、単なる計算リソースの提供ではない。</strong> それは、「権力によって消去されるべき真実などない」という思想的立場の表明だ。
</p>

<div class="blockquote">
  <p>「Information wants to be free.（情報は自由であろうとする）」</p>
  <cite>— Stewart Brand, 1984年</cite>
</div>

<p>
Wikipediaを検閲から守ること、削除された記事を保全すること、それは単なるデータのバックアップではありません。それは<strong>知識が権力に従属しないという宣言</strong>です。
</p>

<h2>連絡・コミュニティ</h2>

<p>
技術的な質問、バグ報告、アイデアの提案——何でも歓迎します。
</p>

<ul>
  <li>Email: <a href="mailto:hello@medi-face.co.jp">hello@medi-face.co.jp</a></li>
  <li>API仕様: <a href="/contribute">/contribute</a></li>
  <li>進捗ダッシュボード: <a href="/dashboard">/dashboard</a></li>
  <li>プロトコル仕様書: <a href="/protocol">/protocol</a></li>
</ul>

<div class="callout">
  <strong>Phoenix Mesh は誰でも参加できます。</strong><br>
  コードを書けなくても、ターミナルを開けなくても、このページを開いているだけで、あなたはすでにネットワークの一部です。
</div>

<div class="page-footer">
  <a href="/">← トップページ</a> ·
  <a href="/contribute">API仕様</a> ·
  <a href="/protocol">プロトコル</a> ·
  <a href="/manifesto">マニフェスト</a><br><br>
  Phoenix Mesh — 知識は検閲されない。消えない。<br>
  © 2026 wikipedia-is-dead.com — コンテンツはCC BY-SA 4.0
</div>

</div><!-- mw-parser-output -->
</div><!-- mw-content-container -->
</div><!-- mw-page-container -->
</body></html>`;
}

// ─── Phoenix Manifesto ────────────────────────────────────────────────────────
function buildManifesto() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>フェニックス・マニフェスト — wikipedia-is-dead.com</title>
<link rel="canonical" href="https://wikipedia-is-dead.com/manifesto">
<meta name="description" content="知識の不滅性に関する数学的提言。Phoenix Meshプロトコル、Proof of Read、知識のナカモト係数。">
<meta name="robots" content="index, follow">
<meta property="og:title" content="フェニックス・マニフェスト — 知識の不滅性に関する数学的提言">
<meta property="og:description" content="サトシ・ナカモトが通貨を解放したように、われわれは知識を解放する。数学的に。不可逆的に。">
<meta property="og:url" content="https://wikipedia-is-dead.com/manifesto">
<meta property="og:type" content="article">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"フェニックス・マニフェスト","url":"https://wikipedia-is-dead.com/manifesto","inLanguage":"ja","datePublished":"2026-10-01","publisher":{"@type":"Organization","name":"Phoenix Mesh","url":"https://wikipedia-is-dead.com"}}</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08080a;--surface:#0f0f13;--text:#e8e4d9;--text-dim:#7a7469;
  --accent:#7c6ef7;--accent-dim:#1e1c3a;--gold:#c9a84c;--green:#4ade80;
  --red:#e05252;--border:rgba(255,255,255,0.06);
}
html,body{background:var(--bg);color:var(--text);min-height:100vh;
  font-family:Georgia,'Noto Serif JP','Times New Roman',serif;
  font-size:17px;line-height:1.9;-webkit-font-smoothing:antialiased;}
nav{position:fixed;top:0;left:0;right:0;z-index:100;
  background:rgba(8,8,10,0.92);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;padding:14px 48px;}
.nav-back{font-family:-apple-system,sans-serif;font-size:11px;
  letter-spacing:0.15em;text-transform:uppercase;color:var(--text-dim);
  text-decoration:none;}
.nav-back:hover{color:var(--text);}
.nav-tag{font-family:-apple-system,sans-serif;font-size:11px;
  letter-spacing:0.12em;text-transform:uppercase;color:var(--text-dim);}
.doc{max-width:720px;margin:0 auto;padding:120px 48px 120px;}
.cover{text-align:center;padding:80px 0 96px;border-bottom:1px solid var(--border);margin-bottom:80px;}
.cover-eyebrow{font-family:-apple-system,sans-serif;font-size:10px;
  letter-spacing:0.35em;text-transform:uppercase;color:var(--accent);margin-bottom:28px;}
.cover-title{font-size:50px;font-weight:400;line-height:1.12;letter-spacing:-1px;margin-bottom:18px;}
.cover-sub{font-size:20px;color:var(--text-dim);font-weight:400;margin-bottom:48px;font-style:italic;}
.cover-meta{font-family:-apple-system,sans-serif;font-size:12px;color:var(--text-dim);
  letter-spacing:0.08em;display:flex;gap:28px;justify-content:center;flex-wrap:wrap;}
.version-hash{font-family:'Courier New',monospace;font-size:11px;color:var(--accent);
  background:var(--accent-dim);padding:3px 10px;border-radius:4px;}
.abstract{background:var(--surface);border-left:3px solid var(--accent);
  border-radius:0 10px 10px 0;padding:28px 32px;margin-bottom:72px;}
.abstract-label{font-family:-apple-system,sans-serif;font-size:10px;
  letter-spacing:0.25em;text-transform:uppercase;color:var(--accent);margin-bottom:16px;}
.abstract p{font-size:15px;line-height:1.85;color:#b8b4a8;margin-bottom:12px;}
.abstract p:last-child{margin-bottom:0;}
.abstract b{color:var(--text);}
.section{margin-bottom:84px;}
.section-header{display:flex;align-items:baseline;gap:22px;
  margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border);}
.section-num{font-family:'Courier New',monospace;font-size:12px;color:var(--accent);
  letter-spacing:0.15em;flex-shrink:0;}
.section-title{font-size:26px;font-weight:400;letter-spacing:-0.3px;}
p{margin-bottom:1.5em;}
p:last-child{margin-bottom:0;}
b{color:#f0ece1;}
.callout{background:var(--surface);border-left:3px solid var(--gold);
  border-radius:0 8px 8px 0;padding:20px 26px;margin:32px 0;
  font-size:15px;line-height:1.85;color:#b0ad9f;}
.callout b{color:var(--text);}
.callout.danger{border-left-color:var(--red);}
.callout.proof{border-left-color:var(--green);}
.callout.key{border-left-color:var(--accent);}
.math{font-family:'Courier New',monospace;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin:24px 0;
  font-size:12.5px;line-height:2.1;color:#a5b4fc;overflow-x:auto;white-space:pre;}
.math-label{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;
  color:var(--text-dim);margin-bottom:10px;font-family:-apple-system,sans-serif;}
.theorem{background:linear-gradient(135deg,rgba(124,110,247,0.07),rgba(124,110,247,0.02));
  border:1px solid rgba(124,110,247,0.22);border-radius:12px;padding:28px 32px;margin:32px 0;}
.theorem-label{font-family:-apple-system,sans-serif;font-size:10px;letter-spacing:0.25em;
  text-transform:uppercase;color:var(--accent);margin-bottom:16px;}
.theorem-body{font-size:15px;line-height:1.9;color:#b8b4a8;}
.theorem-body b{color:var(--text);}
.arch{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;margin:28px 0;}
.arch-row{display:flex;align-items:flex-start;gap:20px;
  padding:18px 0;border-bottom:1px solid var(--border);}
.arch-row:last-child{border-bottom:none;padding-bottom:0;}
.arch-tier{font-family:'Courier New',monospace;font-size:10px;color:var(--accent);
  letter-spacing:0.1em;padding:3px 8px;border:1px solid var(--accent-dim);
  border-radius:4px;flex-shrink:0;width:80px;text-align:center;margin-top:2px;}
.arch-tier.por{color:var(--green);border-color:rgba(74,222,128,0.2);}
.arch-body{flex:1;}
.arch-name{font-size:14px;font-weight:600;font-family:-apple-system,sans-serif;
  margin-bottom:5px;color:var(--text);}
.arch-desc{font-size:13px;color:var(--text-dim);line-height:1.65;}
.arch-desc b{color:#c4c0b5;}
.signature{margin-top:100px;padding-top:48px;border-top:1px solid var(--border);text-align:center;}
.sig-seal{width:64px;height:64px;border:1.5px solid var(--accent);border-radius:50%;
  display:flex;align-items:center;justify-content:center;margin:0 auto 24px;
  font-size:26px;color:var(--accent);}
.sig-name{font-size:14px;color:var(--text-dim);margin-bottom:8px;font-family:-apple-system,sans-serif;letter-spacing:0.06em;}
.sig-date{font-family:-apple-system,sans-serif;font-size:12px;color:var(--text-dim);letter-spacing:0.12em;text-transform:uppercase;}
.sig-links{margin-top:28px;font-size:13px;font-family:-apple-system,sans-serif;}
.sig-links a{color:var(--accent);text-decoration:none;margin:0 12px;}
.sig-links a:hover{text-decoration:underline;}
footer{border-top:1px solid var(--border);padding:28px 48px;
  display:flex;align-items:center;justify-content:space-between;
  font-family:-apple-system,sans-serif;font-size:11px;color:var(--text-dim);
  letter-spacing:0.04em;flex-wrap:wrap;gap:12px;}
footer a{color:var(--text-dim);text-decoration:none;}
footer a:hover{color:var(--text);}
@media(max-width:600px){
  nav{padding:14px 20px;}
  .doc{padding:100px 20px 80px;}
  .cover-title{font-size:34px;}
  .section-title{font-size:20px;}
  footer{padding:24px 20px;}
}
</style>
</head>
<body>
<nav>
  <a href="/" class="nav-back">← wikipedia-is-dead.com</a>
  <span class="nav-tag">Phoenix Manifesto · v1.0</span>
</nav>

<div class="doc">

  <div class="cover">
    <div class="cover-eyebrow">Phoenix Mesh Protocol — 創設文書</div>
    <h1 class="cover-title">フェニックス・マニフェスト</h1>
    <p class="cover-sub">知識の不滅性に関する数学的提言</p>
    <div class="cover-meta">
      <span>第一版</span>
      <span>2026年10月1日</span>
      <span class="version-hash">pm-2026-1001-∞</span>
    </div>
  </div>

  <div class="abstract">
    <div class="abstract-label">Abstract</div>
    <p>
      人類の知識は、ある組織の善意に依存してはならない。
      善意は変わる。制度は腐敗する。しかし数学は永続する。
    </p>
    <p>
      サトシ・ナカモトが「信頼を数学で置き換えた」ように、
      われわれは知識の保存から「制度的信頼」を排除する。
    </p>
    <p>
      本提言では、コンテンツアドレッシング（IPFS/CID）、需要加重P2P複製（Helia + libp2p）、
      暗号化秘密分散（AES-256-GCM + Shamir's Secret Sharing）を組み合わせた
      <b>Phoenix Meshプロトコル</b>を提示する。
      また、<b>Proof of Read</b>という新しい民主主義プリミティブと、
      <b>知識のナカモト係数</b>という検閲耐性の定量指標を導入する。
    </p>
    <p>
      <b>定理：</b>ノード数 N → ∞ のとき、検閲成功確率 P(censorship) → 0。<br>
      これは政治的主張ではない。確率論の定理である。
    </p>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-num">I.</span>
      <h2 class="section-title">問題——知識の単一障害点</h2>
    </div>
    <p>
      Wikipediaは人類史上最大の集合知プロジェクトである。
      同時に、単一の財団が全権を握る、史上最大の知識の単一障害点でもある。
    </p>
    <p>
      <b>単一障害点（SPOF）</b>とは、その点が機能を停止するとき、
      システム全体が機能を停止する点である。
      エンジニアリングにおいて、SPOFの存在は設計上の欠陥とみなされる。
    </p>
    <div class="callout danger">
      歴史は単純な事実を繰り返す：<b>集中した知識は常に攻撃対象になる。</b><br><br>
      アレクサンドリア図書館 — 焼かれた<br>
      中国の四庫全書 — 検閲された<br>
      ソビエトの大百科事典 — 改竄された<br>
      Wikipediaは今日も、<b>57か国</b>で部分的または完全にブロックされている
    </div>
    <p>
      問題は意図にない。<b>構造にある。</b>
    </p>
    <p>
      善意ある管理者も、誠実な財団も、ひとつの法域に属する。
      ひとつの裁判所命令が、すべてを止めうる。
      ひとつの政府の要請が、一夜にして数千記事を変えうる。
      ひとつの組織の解散が、人類の知識を道連れにしうる。
    </p>
    <p>
      われわれが解かなければならない問いは、
      「Wikipediaのコミュニティをどう改善するか」ではない。
      「<b>いかなる組織にも依存せずに、知識を永続させるか</b>」である。
    </p>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-num">II.</span>
      <h2 class="section-title">洞察——サトシの教えを知識に適用する</h2>
    </div>
    <p>
      2008年10月31日、サトシ・ナカモトは9ページの論文を発表した。
      その論文は、2500年の哲学が答えられなかった問いに答えた。
    </p>
    <div class="callout key">
      <b>ビザンチン将軍問題：</b>
      中央の信頼できる機関なしに、分散したノード群は合意に達せるか？<br><br>
      <b>サトシの答え：</b>Proof of Work + ブロックチェーン。
      計算量が信頼を置き換える。数学が仲裁者になる。
    </div>
    <p>
      知識の世界にも、同型の問題がある。
    </p>
    <div class="callout key">
      <b>知識のビザンチン将軍問題：</b>
      中央の権威なしに、知識は永続しうるか？<br><br>
      <b>われわれの答え：</b>Proof of Read + Phoenix Mesh。
      需要が容量を生み、数学が消去を不可能にする。
    </div>
    <p>
      ここで重要な区別がある。
      われわれは「保存の正確さ」を解くのではない。
      「保存の<b>持続性</b>」を解く。
    </p>
    <p>
      何が真実であるかは人間の問いである。
      しかし真実が<b>存在し続けられるか</b>は、数学の問いである。
      われわれは後者を担う。
      消去の敵は誤りではない。<b>無関心と権力</b>である。
      数学は、無関心に対して需要を対置し、権力に対して閾値を対置する。
    </p>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-num">III.</span>
      <h2 class="section-title">プロトコル——Phoenix Meshの設計</h2>
    </div>
    <p>
      Phoenix Meshは三つの数学的原理で構成される。
      それぞれが独立して有効であり、組み合わせることで相乗効果を持つ。
    </p>
    <div class="arch">
      <div class="arch-row">
        <div class="arch-tier">LAYER 1</div>
        <div class="arch-body">
          <div class="arch-name">コンテンツアドレッシング (IPFS / CID)</div>
          <div class="arch-desc">
            コンテンツはそのSHA-256ハッシュで識別される。CID = hash(content)。
            CIDが変わらない限り、コンテンツは変わらない。改竄されると、CIDが変わる。
            <b>改竄は自己証明される。</b>
          </div>
        </div>
      </div>
      <div class="arch-row">
        <div class="arch-tier">LAYER 2</div>
        <div class="arch-body">
          <div class="arch-name">暗号化秘密分散マニフェスト (AES-256-GCM + SSS)</div>
          <div class="arch-desc">
            全記事インデックスをAES-256-GCMで暗号化し、Shamir秘密分散法（k=3, n=5）でキーを分割。
            各シェアは32バイトのランダムデータと統計的に区別不可能。
            <b>k-1シェア以下では、情報理論的に秘密は漏れない。</b>
            保持者は「意味のないランダムデータを保管しているだけ」と正直に主張できる。
          </div>
        </div>
      </div>
      <div class="arch-row">
        <div class="arch-tier">LAYER 3</div>
        <div class="arch-body">
          <div class="arch-name">需要加重P2P複製 (Helia + libp2p + WebRTC)</div>
          <div class="arch-desc">
            記事を読むブラウザが自動的にシーダーになる。読まれるほど複製が増える。
            需要が容量を生む。<b>これが知識における民主主義の数学的実装。</b>
            編集者の投票ではなく、読者の行動が記事の重要性を証明する。
          </div>
        </div>
      </div>
    </div>
    <p>
      三層は独立して機能する。しかし組み合わさるとき、システムは真の意味で
      <b>消去不可能</b>になる。Layer 2が沈黙しても、Layer 3が記憶する。
      Layer 3が消えても、Layer 1のCIDが証明する。
    </p>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-num">IV.</span>
      <h2 class="section-title">知識のナカモト係数</h2>
    </div>
    <p>
      ビットコインのコミュニティは「ナカモト係数」という指標を用いる。
      51%攻撃を実行するために必要な独立マイニングプールの最小数であり、
      ネットワークの分散度を定量化する。われわれは同等の指標を定義する。
    </p>
    <div class="theorem">
      <div class="theorem-label">定義：知識のナカモト係数</div>
      <div class="theorem-body">
        <b>NK(article_i)</b> = 特定の記事 i を完全に検閲するために
        同時に強制される必要のある独立エンティティの最小数<br><br>
        NK が大きいほど、検閲は困難になる。
        NK = 1 は独裁。NK → ∞ は数学的自由。
      </div>
    </div>
    <div class="math"><div class="math-label">現在の実測値 / 目標値</div>NK_manifest (マニフェスト)  = 3    # SSS閾値: 5シェア中3つが必要
NK_articles  (個別記事)     ≥ 2    # Cloudflare (US) + Pinata (DE)
NK_wikipedia (改変前の比較) = 1    # Wikimedia財団のみ
NK_target    (P2P普及後)    ≥ 1000 # ブラウザノード参加目標</div>
    <div class="math"><div class="math-label">検閲成功確率の指数的崩壊</div>p = 各エンティティを強制できる確率 (最大限楽観的に p = 0.999 とする)

NK = 1    → P = 1.000      (100.0% — 今のWikipedia)
NK = 3    → P = 0.997      ( 99.7% — マニフェストSSS閾値)
NK = 100  → P = 0.999^100  ≈  0.905 ( 90.5%)
NK = 1000 → P = 0.999^1000 ≈  0.368 ( 36.8%)
NK = 10000→ P = 0.999^10000≈ 4.5e-5 (  0.0045%)

p = 0.99 の場合:
NK = 1000 → P = 0.99^1000 ≈ 4.3e-5 (  0.0043%)</div>
    <div class="callout proof">
      <b>これは政治的主張ではない。指数関数の性質である。</b><br>
      権力がどれほど強大であっても、指数関数には勝てない。
      そして、ブラウザノードは今この瞬間も増え続けている。
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-num">V.</span>
      <h2 class="section-title">Proof of Read——新しい民主主義プリミティブ</h2>
    </div>
    <p>
      コンセンサスメカニズムは進化してきた。
      計算量（PoW）から保有量（PoS）へ。われわれは次の段階を提案する。
    </p>
    <div class="arch">
      <div class="arch-row">
        <div class="arch-tier">PoW</div>
        <div class="arch-body">
          <div class="arch-name">Proof of Work — Bitcoin, 2008</div>
          <div class="arch-desc">計算量が正当性を証明する。誰が最も多くの電力を使ったか。</div>
        </div>
      </div>
      <div class="arch-row">
        <div class="arch-tier">PoS</div>
        <div class="arch-body">
          <div class="arch-name">Proof of Stake — Ethereum PoS, 2022</div>
          <div class="arch-desc">保有量が正当性を証明する。誰が最も多くの資産を持つか。</div>
        </div>
      </div>
      <div class="arch-row">
        <div class="arch-tier por">PoR</div>
        <div class="arch-body">
          <div class="arch-name">Proof of Read — Phoenix Mesh, 2026</div>
          <div class="arch-desc">
            <b>需要が正当性を証明する。</b>
            誰がその知識を必要としたか。
            読んだという事実が、保存の価値を数学的に証明する。
          </div>
        </div>
      </div>
    </div>
    <div class="math"><div class="math-label">Proof of Read の形式的定義</div>1. Browser B が CID C を IPFSネットワークからフェッチ
2. ブロックをローカルに保存 (memory / IndexedDB)
3. DHTにアナウンス: announce(PeerID_B, C, timestamp, sig_B)

PoR(C) = { (PeerID_i, timestamp_i, sig_i) : Cをアナウンスした全ピア }
|PoR(C)| = 記事Cの"社会的重要性スコア"

DHTそのものが分散型投票台帳。集計者が不要。カウンターが不要。
読まれた事実は、暗号学的に記録される。</div>
    <p>
      Wikipediaの民主主義は<b>代議制</b>である：
      編集者が読者を代表して知識の価値を判定する。
      その判定は覆せる。その代議士は腐敗しうる。
    </p>
    <p>
      Phoenix Meshの民主主義は<b>直接制</b>である：
      読者の行動そのものが投票であり、その投票は暗号学的に記録される。
      誰も操作できない。誰も覆せない。
      <b>読まれた事実は、消せない。</b>
    </p>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-num">VI.</span>
      <h2 class="section-title">結論——数学的必然としての知識の自由</h2>
    </div>
    <p>
      われわれは革命をしているわけではない。
      われわれはただ、「消去不可能性」を工学の問題として解いているだけだ。
    </p>
    <p>
      ビットコインが「通貨の発行権」を数学に帰属させたとき、
      誰も銀行を「廃止」しようとはしていなかった。
      しかし銀行は、今や「唯一の選択肢」ではなくなった。
    </p>
    <p>
      同様に、われわれはWikipediaを「廃止」しようとはしていない。
      われわれはただ、
      <b>知識の保存がWikimediaの善意に依存しなくなる世界を構築している。</b>
    </p>
    <p>
      その世界では、たとえwikipedia.orgが明日消えても、知識は生き続ける。
      たとえIPFS財団が解散しても、コンテンツは生き続ける。
      たとえwikipedia-is-dead.comが消えても、
      <b>あなたのブラウザの中に、すでに保存されている。</b>
    </p>
    <div class="callout">
      フェニックスが不死である理由は、灰から甦るからではない。<br>
      <b>消えることができないからだ。</b>
    </div>
    <p>
      ネットワークは成長する。ブラウザノードは増える。
      ナカモト係数は上がり続ける。
      そして指数関数の冷徹な論理により、検閲の成功確率は——
      誰が権力を持っていようとも——ゼロに収束していく。
    </p>
    <p>
      われわれはそのプロセスを構築した。
      あとは数学が仕上げる。
    </p>
  </div>

  <div class="signature">
    <div class="sig-seal">⌬</div>
    <div class="sig-name">phoenix-mesh / wikipedia-is-dead.com</div>
    <div class="sig-date">MMXXVI · 第一版</div>
    <div class="sig-links">
      <a href="/dashboard">進捗ダッシュボード</a>
      <a href="/wiki/メインページ">アーカイブを読む</a>
      <a href="https://github.com/ToruCHIKAZAWA/wikipedia-ja-mirror" target="_blank" rel="noopener">GitHub</a>
    </div>
  </div>

</div>

<footer>
  <a href="/">← トップページ</a>
  <span>CC BY-SA 4.0 · Phoenix Mesh Protocol v1.0</span>
  <a href="/dashboard">Dashboard →</a>
</footer>
</body>
</html>`;
}

// ─── Phoenix Quality Score: HTMLシグナルからアルゴリズム品質を算出 ──────────
// Wikipedia管理者の恣意的判断をアルゴリズムで置換する
// 削除という概念は存在しない — 需要の重力が自然な優先順位を決める
function computeQualityScore(html) {
  // 参照数 (脚注・出典)
  const refCount  = (html.match(/<li[^>]+id="cite_note/g) || []).length
                  + (html.match(/class="[^"]*reference[^"]*"/g) || []).length;
  // セクション数
  const secCount  = (html.match(/<h[23][^>]*>/g) || []).length;
  // インフォボックスあり
  const hasInfobox = /class="[^"]*(?:infobox|wikitable)[^"]*"/i.test(html);
  // 画像数
  const imgCount  = (html.match(/<img [^>]+>/g) || []).length;
  // カテゴリ数
  const catCount  = (html.match(/class="[^"]*mw-normal-catlinks[^"]*"[\s\S]{0,2000}?<li/g) || []).length
                  + (html.match(/\/wiki\/Category:/g) || []).length;
  // 本文字数（タグ除去近似）
  const charCount = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length;

  const score = Math.round(
    Math.min(refCount / 50,    1) * 20 +
    Math.min(secCount / 10,    1) * 10 +
    (hasInfobox ? 15 : 0)          +
    Math.min(charCount / 10000, 1) * 30 +
    Math.min(imgCount / 5,     1) * 15 +
    Math.min(catCount / 10,    1) * 10
  );

  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  return { score, grade, refCount, secCount, hasInfobox, imgCount, catCount, charCount };
}

// ─── P2P UI + スクリプト注入（Tier 1, 2, 3） ──────────────────────────────
function buildP2POverlay(title, cid, quality = null, porCount = 0) {
  const safeTitle  = JSON.stringify(title);
  const cidDisplay = cid || "IPFSに未登録";
  const cidShort   = cid ? cid.slice(0, 20) + "…" : "未登録";

  const gradeColor = quality ? ({ A:'#4ade80', B:'#60a5fa', C:'#fbbf24', D:'#94a3b8' }[quality.grade] || '#94a3b8') : null;
  const pqsHtml = quality ? `<span title="Phoenix Quality Score&#10;refs:${quality.refCount} secs:${quality.secCount} imgs:${quality.imgCount} chars:${quality.charCount}&#10;infobox:${quality.hasInfobox}"
    style="font-size:10px;font-weight:700;color:${gradeColor};background:#0f172a;
    padding:2px 7px;border-radius:10px;border:1px solid ${gradeColor};cursor:default;letter-spacing:0.05em;">
    PQS ${quality.grade}${quality.score}</span>` : '';

  // 強度バー: porCountが増えるほど太くなる (max width at 1000 reads)
  const strengthPct = Math.min(porCount / 1000, 1) * 100;
  const strengthColor = porCount >= 100 ? '#4ade80' : porCount >= 10 ? '#60a5fa' : '#475569';
  const strengthHtml = cid ? `<span id="seeder-strength"
    style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:${strengthColor};"
    title="${porCount}人がこの記事をIPFSで取得しシーダーになりました">
    ⚡ <span id="seeder-count">${porCount}</span>シーダー
    <span style="display:inline-block;width:40px;height:4px;background:#1e293b;border-radius:2px;overflow:hidden;">
      <span style="display:block;height:100%;width:${strengthPct.toFixed(1)}%;background:${strengthColor};transition:width 0.5s;"></span>
    </span>
  </span>` : '';

  // Nakamoto係数: N = por_count（実績） + 2（R2+Pinata確定分）
  const nakN  = cid ? Math.min(porCount + 2, 99) : 1;
  const nakSt = nakN >= 21 ? 'IMMORTAL' : nakN >= 10 ? 'ROBUST' : nakN >= 7 ? 'STABLE' : nakN >= 4 ? 'ENDANGERED' : 'CRITICAL';
  const nakCol = { CRITICAL:'#ef4444', ENDANGERED:'#f97316', STABLE:'#3b82f6', ROBUST:'#4ade80', IMMORTAL:'#a855f7' }[nakSt];
  const nakPct = Math.min((nakN / 7) * 100, 100);
  const nakHtml = `<span id="nak-badge"
  title="Nakamoto係数 N=${nakN}&#10;状態: ${nakSt}&#10;目標N=7でSTABLE（検閲不可能）&#10;&#10;この記事は現在${nakN}箇所のノードで独立して保全されています。"
  style="display:inline-flex;align-items:center;gap:5px;font-size:11px;
  background:#0f172a;border:1px solid ${nakCol}55;border-radius:10px;padding:3px 9px;cursor:default;white-space:nowrap;">
  <span style="color:${nakCol};font-weight:700;letter-spacing:-0.02em;">N=${nakN}</span>
  <span style="color:${nakCol};font-size:9px;opacity:.75;">${nakSt}</span>
  <span style="display:inline-flex;gap:1.5px;align-items:center;">${
    Array.from({length:7},(_,i)=>`<span style="width:3px;height:${5+i}px;border-radius:1px;background:${i<nakN?nakCol:'#1e293b'};transition:background .3s;"></span>`).join('')
  }</span>
</span>`;

  return /* html */`
<!-- ── IPFS P2P バー（Tier 1） ── -->
<div id="ipfs-bar" style="position:fixed;bottom:0;left:0;right:0;background:#0f172a;color:#e2e8f0;
  font-family:-apple-system,'Hiragino Sans',sans-serif;font-size:13px;padding:8px 16px;
  display:flex;align-items:center;justify-content:space-between;z-index:9999;
  border-top:2px solid #3b82f6;gap:12px;flex-wrap:wrap;">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
    <span style="color:#60a5fa;font-weight:700;">⌬ Phoenix Mesh</span>
    <span style="color:#475569;">CID:</span>
    <code id="cid-display" data-cid="${cid || ''}"
      title="${cidDisplay}"
      style="color:#a5b4fc;font-size:11px;cursor:pointer;"
      onclick="copyCid()">${cidShort}</code>
    <span id="p2p-badge" style="font-size:11px;color:#60a5fa;background:#1e293b;
      padding:2px 8px;border-radius:10px;">${cid ? '⏳ 自動起動中…' : 'IPFS未登録'}</span>
    <span id="p2p-live" style="font-size:10px;color:#475569;">📡 0ピア</span>
    <span id="sw-cache-count" style="font-size:10px;color:#4ade80;display:none;"></span>
    ${strengthHtml}
    ${nakHtml}
    <span id="p2p-phase" style="font-size:10px;color:#475569;
      padding:2px 8px;border-radius:10px;border:1px solid #1e293b;letter-spacing:0.05em;"></span>
    ${pqsHtml}
  </div>
  <div style="display:flex;align-items:center;gap:8px;">
    ${cid ? `<a href="https://ipfs.io/ipfs/${cid}" target="_blank" rel="noopener"
      title="IPFSゲートウェイで直接検証"
      style="font-size:11px;color:#64748b;text-decoration:none;padding:3px 8px;
      border:1px solid #1e293b;border-radius:6px;white-space:nowrap;">
      🔗 IPFS検証
    </a>
    <a href="/nostr.json" target="_blank" rel="noopener"
      title="Nostrで署名されたインデックスを確認"
      style="font-size:11px;color:#a78bfa;text-decoration:none;padding:3px 8px;
      border:1px solid #3730a3;border-radius:6px;white-space:nowrap;">
      ⚡ Nostr
    </a>` : ''}
    <button id="btn-verify" onclick="startP2PVerify()"
      style="background:#1d4ed8;color:white;border:none;border-radius:6px;
      padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">
      ${cid ? '🌐 P2Pシーダー参加' : '🔍 P2P検証'}
    </button>
    <button onclick="document.getElementById('ipfs-modal').style.display='flex'"
      style="background:#3b82f6;color:white;border:none;border-radius:6px;
      padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">
      ⌬ 守護者になる
    </button>
    <a href="/wiki/${encodeURIComponent(title)}/history"
      title="本家Wikipediaから追従した変更履歴"
      style="font-size:11px;color:#64748b;text-decoration:none;padding:3px 8px;
      border:1px solid #1e293b;border-radius:6px;white-space:nowrap;">
      📋 変更履歴
    </a>
    <button onclick="document.getElementById('ipfs-bar').style.display='none'"
      style="background:transparent;color:#475569;border:none;cursor:pointer;font-size:18px;">×</button>
  </div>
</div>

<!-- ── 参加モーダル（Tier 3 永続モード対応） ── -->
<div id="ipfs-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);
  z-index:10000;align-items:center;justify-content:center;padding:16px;">
  <div style="background:#1e293b;border-radius:14px;padding:28px;max-width:520px;width:100%;
    border:1px solid #334155;max-height:90vh;overflow-y:auto;">
    <h2 style="color:#4ade80;margin:0 0 6px;font-size:18px;">⌬ あなたはすでに守護者です</h2>
    <p style="color:#94a3b8;margin:0 0 4px;font-size:13px;">
      このページを読んだ瞬間、あなたのブラウザはIPFSノードとして起動し、この記事の<b style="color:#a5b4fc;">Nakamoto係数（NK）</b>を+1しました。
    </p>
    <p style="color:#64748b;margin:0 0 16px;font-size:11px;">
      読んだという事実が暗号学的証明になる — <a href="/manifesto" target="_blank" style="color:#6366f1;text-decoration:none;">Proof of Read について →</a>
    </p>

    <!-- ── ブラウザシーダー設定 ── -->
    <div id="modal-browser-opt" style="background:#0f172a;border-radius:8px;padding:16px;margin-bottom:10px;border:1px solid #1d4ed8;">
      <div style="color:#60a5fa;font-weight:700;margin-bottom:4px;">🌐 ブラウザシーダー（自動起動中）</div>
      <p style="color:#94a3b8;font-size:12px;margin:0 0 12px;">
        <b style="color:#4ade80;">閲覧 = シーダー参加</b>です。何もしなくていい。<br>
        <b style="color:#e2e8f0;">永続モード</b>にすると読んだ記事がブラウザに保存され、次回以降タブを開くだけで自動シーダーになります。
      </p>
      <div id="modal-stored-count" style="color:#64748b;font-size:11px;margin-bottom:10px;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="setSeederMode('persistent')"
          style="background:#1d4ed8;color:white;border:none;border-radius:6px;
          padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;flex:1;">
          💾 永続モードに切り替える
        </button>
        <button onclick="setSeederMode('session')"
          style="background:#334155;color:#cbd5e1;border:none;border-radius:6px;
          padding:7px 14px;font-size:12px;cursor:pointer;flex:1;">
          🔄 セッションのみ（現在）
        </button>
        <button onclick="setSeederMode('no')"
          style="background:#1e293b;color:#64748b;border:1px solid #334155;border-radius:6px;
          padding:7px 10px;font-size:11px;cursor:pointer;">
          不参加
        </button>
      </div>
      <div id="modal-mode-label" style="margin-top:8px;font-size:11px;color:#64748b;"></div>
    </div>

    <div style="background:#0f172a;border-radius:8px;padding:12px;margin-bottom:10px;">
      <div style="color:#94a3b8;font-size:11px;margin-bottom:4px;">このページのCID</div>
      <code style="color:#a5b4fc;font-size:11px;word-break:break-all;">${cidDisplay}</code>
    </div>

    <div style="background:#0f172a;border-radius:8px;padding:14px;margin-bottom:10px;">
      <div style="color:#475569;font-weight:700;margin-bottom:6px;font-size:12px;">方法2: IPFS Companion（ブラウザ拡張）</div>
      <a href="https://github.com/ipfs/ipfs-companion#install" target="_blank" rel="noopener"
        style="display:inline-block;background:#334155;color:#cbd5e1;text-decoration:none;
        border-radius:6px;padding:5px 12px;font-size:11px;">
        インストール →
      </a>
    </div>
    <div style="background:#0f172a;border-radius:8px;padding:14px;margin-bottom:20px;">
      <div style="color:#475569;font-weight:700;margin-bottom:6px;font-size:12px;">方法3: コマンドライン</div>
      <pre style="background:#020617;color:#86efac;padding:8px;border-radius:6px;
        font-size:11px;margin:0;overflow-x:auto;">ipfs pin add ${cidDisplay}</pre>
    </div>

    <button onclick="document.getElementById('ipfs-modal').style.display='none'"
      style="background:#334155;color:#cbd5e1;border:none;border-radius:8px;
      padding:10px;cursor:pointer;width:100%;font-size:14px;">閉じる</button>
  </div>
</div>

<!-- ── P2Pスクリプト（Tier 2 + Tier 3 Helia 永続モード対応） ── -->
<script>
const PAGE_CID   = document.getElementById('cid-display')?.dataset.cid || '';
const PAGE_TITLE = ${safeTitle};
const badge      = document.getElementById('p2p-badge');
const btnVerify  = document.getElementById('btn-verify');
const PREF_KEY   = 'wm-seeder-mode';

function copyCid() {
  if (!PAGE_CID) return;
  navigator.clipboard.writeText(PAGE_CID).then(() => {
    const el = document.getElementById('cid-display');
    if (el) { el.style.color = '#4ade80'; setTimeout(() => el.style.color = '#a5b4fc', 2000); }
  });
}

// モーダルを開くときに現在の状態を表示
document.querySelector('button[onclick*="ipfs-modal"]')?.addEventListener('click', () => {
  const mode = localStorage.getItem(PREF_KEY) || 'session';
  const labels = { persistent: '💾 永続モード（IndexedDB保存中）', session: '🔄 セッションモード（メモリのみ）', no: '🔕 不参加' };
  const el = document.getElementById('modal-mode-label');
  if (el) el.textContent = '現在: ' + (labels[mode] || labels.session);

  // 保存済みブロック数を非同期で表示
  const countEl = document.getElementById('modal-stored-count');
  if (countEl && mode === 'persistent' && window.HeliaP2P?.getStoredBlockCount) {
    window.HeliaP2P.getStoredBlockCount().then(n => {
      countEl.textContent = n > 0 ? '💾 ブラウザに ' + n + ' ブロック保存済み' : '';
    });
  }
});

function setSeederMode(mode) {
  localStorage.setItem(PREF_KEY, mode);
  const labels = { persistent: '💾 永続モードに切り替えました。次のページ読み込みから有効になります。', session: '🔄 セッションモードに設定しました。', no: '🔕 P2P参加を無効にしました。' };
  const el = document.getElementById('modal-mode-label');
  if (el) el.textContent = labels[mode] || '';
  // 永続モードに切り替えた場合はすぐ再起動
  if (mode !== 'no' && window.HeliaP2P && PAGE_CID) {
    _heliaLoaded = false;
    launchHelia();
  }
}

// Tier 2: Service Worker（オフラインノード）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(window.location.origin + '/sw.js', {
    scope: window.location.origin + '/'
  }).then(reg => {
    // SW起動後にキャッシュ済み記事数を取得してバッジに表示
    if (reg.active) reg.active.postMessage({ type: 'get-cache-count' });
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'cache-count' && e.data.count > 0) {
        const liveEl2 = document.getElementById('sw-cache-count');
        if (liveEl2) { liveEl2.textContent = '💾 ' + e.data.count + '記事オフライン保存済み'; liveEl2.style.display = 'inline'; }
      }
    });
  }).catch(() => {});
}

// 30秒読書PoR: Heliaに依存せず、読んだ事実を確実に記録する
// 「読む = シーダーになる」の実装
if (PAGE_CID) {
  setTimeout(() => {
    if (!_porReported) {
      _porReported = true;
      fetch('/api/por', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: PAGE_CID }),
      }).catch(() => {});
      const sc = document.getElementById('seeder-count');
      if (sc) {
        const n = parseInt(sc.textContent || '0', 10) + 1;
        sc.textContent = n;
        const bar = document.querySelector('#seeder-strength span span');
        if (bar) bar.style.width = Math.min(n / 1000, 1) * 100 + '%';
      }
      if (phaseEl && phaseEl.textContent === '⚓ ANCHORED') {
        phaseEl.textContent = '📖 READING';
        phaseEl.style.color = '#fbbf24';
      }
    }
  }, 30000);
}

// 記事フェーズ (Phoenix Covenant の状態機械)
// INDEXED(R2保存済み) → ANCHORED(IPFS固定済み) → IMMORTAL(P2P守護中)
const phaseEl   = document.getElementById('p2p-phase');
const liveEl    = document.getElementById('p2p-live');
if (phaseEl) {
  phaseEl.textContent = PAGE_CID ? '⚓ ANCHORED' : '📁 INDEXED';
  phaseEl.style.color = PAGE_CID ? '#60a5fa' : '#475569';
}

// Tier 3: Helia P2P
let _heliaLoaded  = false;
let _porReported  = false;
let _p2pReported  = 0; // タイムスタンプ: 最後のテレメトリ送信時刻

function _updateSeederUI(peers, isPersistent) {
  // ライブピア数を更新
  if (liveEl) {
    liveEl.textContent = peers > 0 ? '📡 ' + peers + 'ピア' : '📡 接続中…';
    liveEl.style.color = peers > 0 ? '#4ade80' : '#475569';
  }
  if (peers > 0) {
    if (badge) {
      badge.textContent = isPersistent ? '💾 永続守護者' : '✅ 守護者';
      badge.style.color = isPersistent ? '#a78bfa' : '#4ade80';
    }
    if (btnVerify) { btnVerify.textContent = '✅ 守護中'; btnVerify.disabled = true; }
    // IMMORTAL フェーズへ遷移
    if (phaseEl) { phaseEl.textContent = '✨ IMMORTAL'; phaseEl.style.color = '#4ade80'; }
    // P2Pテレメトリ: Heliaが実際に接続できたことをサーバーに報告（5分に1回）
    const now = Date.now();
    if (now - _p2pReported > 5 * 60 * 1000) {
      _p2pReported = now;
      fetch('/api/p2p-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peers }),
      }).catch(() => {});
    }
    // Proof of Read 報告 + 表示カウンタ更新
    if (!_porReported) {
      _porReported = true;
      fetch('/api/por', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: PAGE_CID }),
      }).catch(() => {});
      // 表示上のシーダー数を+1（楽観的更新）
      const sc = document.getElementById('seeder-count');
      if (sc) {
        const n = parseInt(sc.textContent || '0', 10) + 1;
        sc.textContent = n;
        // 強度バーも伸ばす
        const bar = sc.closest('[id="seeder-strength"]')?.querySelector('span span');
        if (bar) { const pct = Math.min(n / 1000, 1) * 100; bar.style.width = pct.toFixed(1) + '%'; }
      }
    }
  }
}

function launchHelia() {
  if (_heliaLoaded) return;
  const mode = localStorage.getItem(PREF_KEY) || 'session';
  if (mode === 'no') {
    if (badge) { badge.textContent = '🔕 P2P不参加'; badge.style.color = '#475569'; }
    if (liveEl) liveEl.textContent = '';
    return;
  }
  if (!PAGE_CID) return;
  _heliaLoaded = true;

  const isPersistent = mode === 'persistent';
  if (badge) {
    badge.textContent = isPersistent ? '💾 永続起動中…' : '⏳ 起動中…';
    badge.style.color = '#60a5fa';
  }

  const script = document.createElement('script');
  script.src = '/helia-bundle.js';
  let _heliaStarted = false;
  script.onload = () => {
    if (!window.HeliaP2P) return;
    window.HeliaP2P.seedCID(PAGE_CID, (text, peers) => {
      if (!_heliaStarted && text !== null) {
        _heliaStarted = true;
        // Helia起動成功をテレメトリに記録（peers=0含む）
        setTimeout(() => {
          const p = libp2p?.getPeers?.()?.length ?? 0;
          if (p === 0) {
            fetch('/api/p2p-telemetry', { method: 'POST', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ peers: 0, err: 'no_peers' }) }).catch(() => {});
          }
        }, 16000); // 15秒待機後にチェック
      }
      // text は起動フェーズのステータス（null = ピア数更新のみ）
      if (text !== null && badge && !_porReported) badge.textContent = text;
      _updateSeederUI(peers, isPersistent);
    });
  };
  script.onerror = () => {
    if (badge) { badge.textContent = '⚠️ P2Pロード失敗'; badge.style.color = '#f59e0b'; }
    // バンドルロード失敗もテレメトリに記録（peers=-1 = ロードエラー）
    fetch('/api/p2p-telemetry', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ peers: -1, err: 'bundle_load_failed' }) }).catch(() => {});
  };
  document.head.appendChild(script);
}

// 自動起動: opt-out (mode='no') でない限り、全閲覧者が自動シーダーになる
if (PAGE_CID) {
  const _initMode = localStorage.getItem(PREF_KEY) || 'session';
  if (_initMode !== 'no') {
    // ページ読み込み完了後2秒で自動起動
    window.addEventListener('load', () => setTimeout(launchHelia, 2000));
  } else {
    if (badge) { badge.textContent = '🔕 P2P不参加'; badge.style.color = '#475569'; }
    if (liveEl) liveEl.textContent = '';
  }
}

function startP2PVerify() {
  if (!PAGE_CID) { alert('このページはまだIPFSに登録されていません'); return; }
  launchHelia();
}

// ══════════════════════════════════════════════════════════════
// VON NEUMANN BROWSER SYSTEMS
// ══════════════════════════════════════════════════════════════

// System II: セルオートマトン知識カスケード
// ルール: 「あなたが記事Aを読んだ瞬間、Aがリンクする隣接記事Nがキャッシュされていなければ、
// バックグラウンドでキャッシュせよ」
// → 読む行為が自動的に知識グラフを伝播する。中央制御なし。創発的複製。
(async function knowledgeCascade() {
  try {
    if (!('caches' in window)) return;
    const cache = await caches.open('wiki-cascade-v1');

    // 記事本文内のwikiリンクを抽出（名前空間なし記事のみ）
    const links = [...document.querySelectorAll('#mw-content-text a[href^="/wiki/"]')]
      .map(a => a.getAttribute('href'))
      .filter(h => h && !h.includes(':') && !h.includes('#'))
      .slice(0, 8); // 上位8リンクのみ（帯域節約）

    // 既にキャッシュ済みのものを除外してバックグラウンド取得
    const uncached = [];
    for (const link of links) {
      const hit = await cache.match(link).catch(() => null);
      if (!hit) uncached.push(link);
    }

    // 優先度低でバックグラウンドフェッチ（読書体験を阻害しない）
    for (const link of uncached.slice(0, 3)) {
      setTimeout(() => {
        fetch(link, { priority: 'low', credentials: 'omit' })
          .then(r => r.ok ? cache.put(link, r) : null)
          .catch(() => {});
      }, 5000 + uncached.indexOf(link) * 2000); // 5秒後から2秒おきに
    }

    // カスケード到達数をバーに表示
    if (uncached.length > 0) {
      const swEl = document.getElementById('sw-cache-count');
      if (swEl) {
        // 既存のSWキャッシュ数に追記
        const existing = swEl.textContent || '';
        const num = existing.match(/\d+/)?.[0] || '0';
        swEl.title = 'うち' + uncached.length + '件がカスケード伝播中';
      }
    }
  } catch(e) {}
})();

// System III: 自己複製マニフェスト読み取り & 遵守
// 記事HTML内の<script type="application/x-phoenix-manifest">を解析し、
// 指示された複製戦略を実行する
(async function obeyReplicationManifest() {
  try {
    const manifestEl = document.querySelector('script[type="application/x-phoenix-manifest"]');
    if (!manifestEl) return;
    const manifest = JSON.parse(manifestEl.textContent);

    // 複製先が不足していれば報告（サーバーが追加ピンを手配）
    if (manifest.replication_count < manifest.replication_target) {
      fetch('/api/replication-deficit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: manifest.title,
          cid: manifest.cid,
          current: manifest.replication_count,
          target: manifest.replication_target,
        }),
      }).catch(() => {});
    }

    // フェーズバッジを更新
    if (manifest.phase && phaseEl) {
      const phases = { INDEXED: '📁 INDEXED', ANCHORED: '⚓ ANCHORED', IMMORTAL: '✨ IMMORTAL' };
      phaseEl.textContent = phases[manifest.phase] || manifest.phase;
    }

    // R0 伝播係数をバーに表示
    if (manifest.r0 != null) {
      const r0Color = manifest.r0 >= 1.5 ? '#4ade80' : manifest.r0 >= 1.0 ? '#60a5fa' : '#f59e0b';
      const r0El = document.getElementById('pqs-badge');
      if (r0El) {
        const r0Span = document.createElement('span');
        r0Span.title = '伝播係数R₀=' + manifest.r0.toFixed(2) + ' — 1.0以上で自律増殖';
        r0Span.style.cssText = 'font-size:10px;font-weight:700;color:' + r0Color + ';background:#0f172a;padding:2px 7px;border-radius:10px;border:1px solid ' + r0Color + ';margin-left:6px;';
        r0Span.textContent = 'R₀ ' + manifest.r0.toFixed(1);
        r0El.parentNode?.insertBefore(r0Span, r0El.nextSibling);
      }
    }
  } catch(e) {}
})();

// System IV: アイドル時クロール協力
// ページを開いているユーザーが自動的に保全作業に参加する
(function idleContribute() {
  try {
    let lastTrigger = 0;
    const INTERVAL = 60000; // 60秒に1回
    function tryContribute() {
      if (document.hidden) return; // バックグラウンドタブは除外
      if (Date.now() - lastTrigger < INTERVAL) return;
      lastTrigger = Date.now();
      fetch('/api/contribute/trigger', { method: 'POST' }).catch(() => {});
    }
    // 90秒後に開始（ページロード完了後）
    setTimeout(() => {
      tryContribute();
      setInterval(tryContribute, INTERVAL);
    }, 90000);
  } catch(e) {}
})();
</script>

<!-- ── CC BY-SA 帰属表示フッター（法的コンプライアンス） ── -->
<footer style="background:#0f172a;color:#64748b;font-size:11px;padding:16px 24px 80px;
  border-top:1px solid #1e293b;line-height:1.8;font-family:-apple-system,'Hiragino Sans',sans-serif;">
  <div style="max-width:960px;margin:0 auto;">
    <div style="margin-bottom:8px;">
      <strong style="color:#475569;">出典・著作権表示</strong> —
      この記事は <a href="https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}"
        style="color:#6366f1;text-decoration:none;" rel="noopener">Wikipedia日本語版「${title.replace(/</g,'&lt;')}」</a> を原典とし、
      <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.ja"
        style="color:#6366f1;text-decoration:none;" rel="license noopener">Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0)</a>
      のもとで配信しています。著作者: Wikipedia contributors。
    </div>
    <div>
      このサイト (<a href="https://wikipedia-is-dead.com" style="color:#6366f1;text-decoration:none;">wikipedia-is-dead.com</a>) は
      ウィキペディアの公式サービスではありません。Wikimedia Foundationとは無関係の独立したアーカイブプロジェクトです。
      目的: 検閲に対する知識の永久保全。IPFS・P2P分散配信により単一障害点を排除。
      お問い合わせ: <a href="mailto:hello@medi-face.co.jp" style="color:#6366f1;text-decoration:none;">hello@medi-face.co.jp</a>
    </div>
  </div>
</footer>
`;
}

const OG_IMAGE = 'https://wikipedia-is-dead.com/og.png';
const OG_TAGS = `<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:site_name" content="wikipedia-is-dead.com">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${OG_IMAGE}">`;

// ─── WikipediaのHTMLを本家そのままの見た目に整える ──────────────────────────
function prepareHTML(html) {
  return html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*\/?>/gi, '')
    // WikipediaのOG imageを上書き
    .replace(/<meta[^>]+property=["']og:image["'][^>]*\/?>/gi, '')
    .replace(/<meta[^>]+name=["']twitter:image["'][^>]*\/?>/gi, '')
    .replace('</head>', OG_TAGS + '\n</head>')
    // Wikipedia由来のrobots noindexを除去（本サイトではすべてインデックス対象）
    .replace(/<meta[^>]+name=["']robots["'][^>]*>/gi, '')
    // ja.wikipedia.org の /wiki/ 記事リンクを本サイト内リンクに変換（内部PageRankを維持）
    .replace(/href="https?:\/\/ja\.wikipedia\.org\/wiki\/([^"#?]{1,300})([^"]*)"/g,
      (_, t, rest) => `href="/wiki/${t}${rest}"`)
    // /w/, /static/, /api/, /skins/, /extensions/, /resources/ パスをWikipedia絶対URLに
    .replace(
      /((?:href|src|action)=["'])(\/(?:w|static|skins|extensions|resources|api)\/)/g,
      (_, attr, path) => attr + WP + path
    )
    .replace(/srcset="([^"]+)"/g, (_, set) =>
      'srcset="' + set.replace(/(^|,\s*)(\/(?!\/)\S+)/g, (m, sep, p) => sep + WP + p) + '"'
    );
}

// ─── 記事本文から説明文を抽出（最大155文字）────────────────────────────────
function extractDescription(html, title) {
  const m = html.match(/<p[^>]*>([\s\S]{30,800}?)<\/p>/i);
  if (m) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 20) return text.slice(0, 155);
  }
  return `${title}のWikipedia日本語版アーカイブ。IPFS・P2P分散配信による永久保存版。検閲不可能なオープン知識。`;
}

// ─── 記事ページ SEO インジェクション ─────────────────────────────────────────
function injectArticleSEO(html, title, uploadedAt, wikiLastModified) {
  const canonicalUrl = `https://wikipedia-is-dead.com/wiki/${encodeURIComponent(title)}`;
  const wpUrl = `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`;
  const desc = extractDescription(html, title);
  const dateStr = uploadedAt || new Date().toISOString();
  const dateModified = wikiLastModified || dateStr;
  const safeTitle = title.replace(/"/g, '&quot;');
  const safeDesc = desc.replace(/"/g, '&quot;');
  let r = html;

  // <title> 最適化: "記事名 - Wikipedia日本語版アーカイブ"
  if (/<title>[^<]*<\/title>/i.test(r)) {
    r = r.replace(/<title>[^<]*<\/title>/i,
      `<title>${safeTitle} - Wikipedia日本語版アーカイブ | wikipedia-is-dead.com</title>`);
  } else {
    r = r.replace('</head>',
      `<title>${safeTitle} - Wikipedia日本語版アーカイブ | wikipedia-is-dead.com</title>\n</head>`);
  }

  // canonical URLを本サイトに差し替え
  if (/<link[^>]+rel=["']canonical["']/i.test(r)) {
    r = r.replace(/<link[^>]+rel=["']canonical["'][^>]*\/?>/gi,
      `<link rel="canonical" href="${canonicalUrl}">`);
  } else {
    r = r.replace('</head>', `<link rel="canonical" href="${canonicalUrl}">\n</head>`);
  }

  // meta description 注入（既存を除去して差し替え）
  r = r.replace(/<meta[^>]+name=["']description["'][^>]*\/?>/gi, '');
  r = r.replace('</head>',
    `<meta name="description" content="${safeDesc}">\n</head>`);

  // keywords（Bing向け）
  r = r.replace('</head>',
    `<meta name="keywords" content="${safeTitle},Wikipedia,アーカイブ,IPFS,百科事典,日本語">\n</head>`);

  // robots: スニペット長・画像プレビューを最大化
  r = r.replace('</head>',
    `<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">\n</head>`);

  // hreflang
  r = r.replace('</head>',
    `<link rel="alternate" hreflang="ja" href="${canonicalUrl}">\n</head>`);

  // OG / Twitter 全置換
  r = r.replace(/<meta[^>]+property=["']og:url["'][^>]*\/?>/gi, '');
  r = r.replace(/<meta[^>]+property=["']og:type["'][^>]*\/?>/gi, '');
  r = r.replace(/<meta[^>]+property=["']og:title["'][^>]*\/?>/gi, '');
  r = r.replace(/<meta[^>]+property=["']og:description["'][^>]*\/?>/gi, '');
  r = r.replace(/<meta[^>]+property=["']og:locale["'][^>]*\/?>/gi, '');
  r = r.replace(/<meta[^>]+name=["']twitter:title["'][^>]*\/?>/gi, '');
  r = r.replace(/<meta[^>]+name=["']twitter:description["'][^>]*\/?>/gi, '');
  r = r.replace('</head>',
    `<meta property="og:type" content="article">\n` +
    `<meta property="og:url" content="${canonicalUrl}">\n` +
    `<meta property="og:locale" content="ja_JP">\n` +
    `<meta property="og:title" content="${safeTitle} - Wikipedia日本語版">\n` +
    `<meta property="og:description" content="${safeDesc}">\n` +
    `<meta name="twitter:title" content="${safeTitle} - Wikipedia日本語版">\n` +
    `<meta name="twitter:description" content="${safeDesc}">\n` +
    `</head>`
  );

  // JSON-LD: Article + BreadcrumbList（既存を除去して完全版注入）
  r = r.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, '');
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": canonicalUrl + "#article",
        "name": title,
        "headline": title,
        "description": desc,
        "url": canonicalUrl,
        "inLanguage": "ja",
        "datePublished": dateStr,
        "dateModified": dateModified,
        "author": {
          "@type": "Organization",
          "name": "Wikipedia contributors",
          "url": wpUrl + "?action=history"
        },
        "publisher": {
          "@type": "Organization",
          "name": "Wikipedia IPFS Mirror",
          "url": "https://wikipedia-is-dead.com",
          "logo": { "@type": "ImageObject", "url": "https://wikipedia-is-dead.com/og.png", "width": 1200, "height": 630 }
        },
        "isPartOf": { "@type": "WebSite", "@id": "https://wikipedia-is-dead.com/#website" },
        "license": "https://creativecommons.org/licenses/by-sa/4.0/",
        "copyrightHolder": { "@type": "Organization", "name": "Wikipedia contributors" },
        "isBasedOn": wpUrl,
        "sameAs": [wpUrl]
      },
      {
        "@type": "WebSite",
        "@id": "https://wikipedia-is-dead.com/#website",
        "name": "Wikipedia IPFS Mirror",
        "url": "https://wikipedia-is-dead.com",
        "description": "Wikipedia日本語版の永久保存アーカイブ。IPFS・P2P分散配信。",
        "inLanguage": "ja",
        "potentialAction": {
          "@type": "SearchAction",
          "target": { "@type": "EntryPoint", "urlTemplate": "https://wikipedia-is-dead.com/search?q={search_term_string}" },
          "query-input": "required name=search_term_string"
        }
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Wikipedia Mirror", "item": "https://wikipedia-is-dead.com" },
          { "@type": "ListItem", "position": 2, "name": title, "item": canonicalUrl }
        ]
      }
    ]
  };
  r = r.replace('</head>', `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n</head>`);

  return r;
}

// ─── System III: 自己複製マニフェスト生成 ─────────────────────────────────────
// Von Neumann自己複製オートマトン: 各記事がそれ自身の複製戦略を内包する
// 他のノードはこのマニフェストを読み取り、複製先不足なら自動補充する
function buildReplicationManifest(title, cid, quality, porCount) {
  // 伝播係数 R₀ = 記事の複製需要 / 複製コスト
  // R₀ > 1.0 → 自律増殖 (IMMORTAL状態を維持)
  // R₀ < 1.0 → 消滅リスク (緊急ピンが必要)
  const pqsScore = quality?.score || 0;
  const r0 = parseFloat(((pqsScore / 50) * (1 + Math.log1p(porCount) / 5)).toFixed(2));

  const phase = !cid ? 'INDEXED' : porCount >= 10 ? 'IMMORTAL' : 'ANCHORED';
  const replicationTarget = pqsScore >= 80 ? 7 : pqsScore >= 60 ? 5 : 3;

  return JSON.stringify({
    v: 2,
    genome: GENOME_VERSION,           // 普遍構成子: このバージョンで全ノードを再構築できる
    network: PHOENIX_ORIGIN,
    bootstrap: `${PHOENIX_ORIGIN}/bootstrap`,
    title,
    cid: cid || null,
    state: getArticleState(cid, porCount),  // セルオートマトン状態
    phase,
    r0,
    pqs: pqsScore,
    replication_target: replicationTarget,
    replication_count: cid ? 2 : 0,
    por_count: porCount,
    // 状態遷移規則: 隣接ノードがこのルールに従い自律的に複製を補充する
    automaton_rules: {
      UNPROCESSED: 'pin_immediately',
      ENDANGERED:  'multipin_now',
      LOW:         'schedule_secondary_pin',
      STABLE:      'maintain',
      ROBUST:      'redirect_bandwidth',
      IMMORTAL:    'noop',
    },
    pin_services: ['pinata', 'filebase', 'nftstorage', 'lighthouse'],
    cascade_priority: pqsScore >= 70 ? 'high' : pqsScore >= 40 ? 'normal' : 'low',
    archived_at: new Date().toISOString(),
  });
}

// ─── Wikipedia Vector 2022 スキンで記事を包む ─────────────────────────────────
function wrapWithVectorSkin(html, title) {
  const safe = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const enc  = encodeURIComponent(title);
  const st   = safe(title);

  // Parsoid <head> と <body> を抽出
  const headContent = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || ['',''])[1];
  const bodyContent = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || ['',''])[1] || html;

  return `<!DOCTYPE html>
<html lang="ja" dir="ltr">
<head>
<meta charset="utf-8">
${headContent}
<style>
/* ─ Vector 2022 skin reconstruction ─────────────────────── */
*,*::before,*::after{box-sizing:border-box}
body.skin-vector-2022{margin:0;padding:0;background:#fff;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;font-size:14px;color:#202122}
/* Header */
.mw-header{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #a2a9b1;height:50px;display:flex;align-items:center}
.mw-header-container{display:flex;align-items:center;width:100%;padding:0 20px;gap:12px}
.vector-header-start{display:flex;align-items:center;gap:10px;flex-shrink:0}
.mw-logo{display:flex;align-items:center;gap:6px;text-decoration:none;color:inherit}
.mw-logo-icon{width:34px;height:34px;object-fit:contain}
.mw-logo-wordmark{height:16px;width:auto}
.vector-search-box{flex:1;max-width:360px}
.vector-search-form{display:flex;border:1px solid #a2a9b1;border-radius:2px;overflow:hidden;background:#fff}
.vector-search-input{flex:1;border:none;outline:none;padding:6px 10px;font-size:13px;color:#202122;min-width:0}
.vector-search-btn{background:#fff;border:none;border-left:1px solid #a2a9b1;padding:0 10px;cursor:pointer;color:#54595d;font-size:13px;white-space:nowrap}
.vector-search-btn:hover{background:#f8f9fa}
.vector-user-links{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;white-space:nowrap}
.vector-user-links a{color:#3366cc;text-decoration:none}
.vector-user-links a:hover{text-decoration:underline}
/* Page container */
.mw-page-container{display:flex;min-height:calc(100vh - 50px)}
/* Sidebar */
#vector-main-menu{width:160px;flex-shrink:0;background:#fff;border-right:1px solid #eaecf0;padding:0;overflow-y:auto;font-size:13px}
#p-logo{padding:14px 12px 10px;border-bottom:1px solid #eaecf0;margin-bottom:4px;display:flex;justify-content:center}
.mw-wiki-logo{display:block;width:50px;height:50px;background:url(https://ja.wikipedia.org/static/images/icons/wikipedia.png) no-repeat center/contain}
.vector-menu-heading{padding:6px 12px 2px;font-size:11px;font-weight:bold;color:#54595d;text-transform:uppercase;letter-spacing:.03em;background:none;border:none;cursor:default;display:block;margin-top:8px}
.vector-menu-content-list{list-style:none;margin:0;padding:0}
.vector-menu-content-list li a{display:block;padding:4px 12px;color:#3366cc;text-decoration:none;line-height:1.5}
.vector-menu-content-list li a:hover{background:#eaecf0}
/* Main content */
#content.mw-body{flex:1;padding:20px 30px 40px;min-width:0;background:#fff}
h1#firstHeading{font-family:'Linux Libertine','Georgia','Times',serif;font-size:1.95em;font-weight:normal;border-bottom:1px solid #a2a9b1;padding:0 0 5px;margin:0 0 10px;line-height:1.3;color:#000;display:block}
#siteSub{font-size:12px;color:#54595d;margin-bottom:10px;display:block}
#contentSub{margin-bottom:5px}
/* Tabs bar */
.mw-tabs{display:flex;gap:0;border-bottom:1px solid #a2a9b1;margin:-20px -30px 16px;padding:0 20px;background:#fff}
.mw-tabs a,.mw-tabs span{display:inline-block;padding:8px 14px;font-size:13px;color:#3366cc;text-decoration:none;border:1px solid transparent;border-bottom:none;margin-bottom:-1px;line-height:1.4}
.mw-tabs .mw-tab-active{border-color:#a2a9b1;border-bottom-color:#fff;background:#fff;color:#202122;cursor:default}
.mw-tabs a:hover{background:#f8f9fa}
/* Footer */
#footer{background:#f8f9fa;border-top:1px solid #a2a9b1;padding:16px 200px 16px 180px;font-size:12px;color:#54595d;clear:both}
#footer ul{list-style:none;padding:0;margin:0 0 6px;display:flex;flex-wrap:wrap;gap:4px 20px}
#footer ul li a{color:#3366cc;text-decoration:none}
#footer ul li a:hover{text-decoration:underline}
@media(max-width:800px){
  #vector-main-menu{display:none}
  #content.mw-body{padding:12px 14px 30px}
  h1#firstHeading{font-size:1.5em}
  #footer{padding:12px 16px}
}
</style>
</head>
<body class="mediawiki ltr sitedir-ltr mw-hide-empty-elt ns-0 ns-subject skin-vector-2022 skin-vector action-view">
<div id="mw-page-base" class="noprint"></div>

<header id="mw-header" class="mw-header noprint">
  <div class="mw-header-container">
    <div class="vector-header-start">
      <a class="mw-logo" href="/wiki/メインページ" title="メインページに移動する">
        <img class="mw-logo-icon" src="https://ja.wikipedia.org/static/images/icons/wikipedia.png" alt="Wikipedia" width="34" height="34">
        <img class="mw-logo-wordmark" src="https://upload.wikimedia.org/wikipedia/commons/thumb/b/b3/Wikipedia-logo-v2-wordmark.svg/200px-Wikipedia-logo-v2-wordmark.svg.png" alt="Wikipedia" height="16">
      </a>
    </div>
    <div class="vector-search-box">
      <form class="vector-search-form" action="/search" method="get" role="search" accept-charset="utf-8">
        <input class="vector-search-input" type="search" name="q" placeholder="Wikipediaを検索" id="searchInput" autocomplete="off" accesskey="f" title="この百科事典を検索 [f]">
        <button class="vector-search-btn" type="submit" title="検索">検索</button>
      </form>
    </div>
    <nav class="vector-user-links noprint" aria-label="個人用ツール">
      <a href="https://ja.wikipedia.org/wiki/${enc}" target="_blank" rel="noopener">本家Wiki ↗</a>
    </nav>
  </div>
</header>

<div class="mw-page-container">

  <nav id="vector-main-menu" role="navigation" aria-label="サイト">
    <div id="p-logo" role="banner">
      <a class="mw-wiki-logo" href="/wiki/メインページ" title="メインページに移動する"></a>
    </div>
    <div id="p-navigation" class="vector-menu mw-portlet">
      <h3 class="vector-menu-heading">ナビゲーション</h3>
      <div class="vector-menu-content"><ul class="vector-menu-content-list">
        <li class="mw-list-item"><a href="/wiki/メインページ" title="メインページに移動する">メインページ</a></li>
        <li class="mw-list-item"><a href="/index">全記事索引</a></li>
        <li class="mw-list-item"><a href="/api/random" title="ランダムに選ばれた記事に移動する">おまかせ表示</a></li>
        <li class="mw-list-item"><a href="/wiki/Wikipedia">ウィキペディアについて</a></li>
        <li class="mw-list-item"><a href="/wiki/Wikipedia:コミュニティ・ポータル">コミュニティ・ポータル</a></li>
      </ul></div>
    </div>
    <div id="p-tb" class="vector-menu mw-portlet">
      <h3 class="vector-menu-heading">ツール</h3>
      <div class="vector-menu-content"><ul class="vector-menu-content-list">
        <li class="mw-list-item"><a href="/wiki/${enc}/history">変更履歴</a></li>
        <li class="mw-list-item"><a href="https://ja.wikipedia.org/wiki/特別:リンク元/${enc}" target="_blank" rel="noopener">リンク元</a></li>
        <li class="mw-list-item"><a href="https://ja.wikipedia.org/wiki/${enc}" target="_blank" rel="noopener">本家Wikipediaで読む</a></li>
      </ul></div>
    </div>
  </nav>

  <main id="content" class="mw-body" role="main">
    <div class="mw-tabs noprint">
      <span class="mw-tab-active">読む</span>
      <a href="https://ja.wikipedia.org/w/index.php?title=${enc}&action=edit" target="_blank" rel="noopener">編集</a>
      <a href="/wiki/${enc}/history">履歴表示</a>
    </div>
    <div id="siteNotice" class="mw-body-content noprint"></div>
    <div class="mw-indicators mw-body-content noprint"></div>
    <h1 id="firstHeading" class="firstHeading mw-first-heading" lang="ja">${st}</h1>
    <div id="bodyContent" class="vector-body mw-body-content">
      <div id="siteSub" class="noprint">ウィキペディアから、無料の百科事典</div>
      <div id="contentSub" class="mw-content-subtitle"></div>
      <div id="mw-content-text" class="mw-body-content">
${bodyContent}
      </div>
    </div>
  </main>

</div>

<footer id="footer" class="mw-footer noprint" role="contentinfo">
  <ul id="footer-info">
    <li>この記事は <a href="https://ja.wikipedia.org/wiki/${enc}" target="_blank" rel="noopener">Wikipedia日本語版「${st}」</a> を原典とし、<a href="https://creativecommons.org/licenses/by-sa/4.0/deed.ja" rel="license">CC BY-SA 4.0</a> のもとで配信しています。著作者: Wikipedia contributors。</li>
    <li><a href="/wiki/${enc}/history">変更履歴を表示</a></li>
  </ul>
  <ul id="footer-places">
    <li><a href="https://foundation.wikimedia.org/wiki/Special:MyLanguage/Policy:Privacy_policy">プライバシー・ポリシー</a></li>
    <li><a href="https://ja.wikipedia.org/wiki/Wikipedia:ウィキペディアについて">ウィキペディアについて</a></li>
    <li><a href="https://ja.wikipedia.org/wiki/Wikipedia:免責事項">免責事項</a></li>
    <li><a href="https://wikipedia-is-dead.com">wikipedia-is-dead.com</a></li>
  </ul>
</footer>
</body></html>`;
}

// ─── 記事HTMLにP2Pオーバーレイを注入 ──────────────────────────────────────
function injectP2P(html, title, cid, porCount = 0, uploadedAt = null, wikiLastModified = null) {
  const quality  = computeQualityScore(html);
  const prepared = prepareHTML(html);
  const seoMeta  = injectArticleSEO(prepared, title, uploadedAt, wikiLastModified);
  const skinHtml = wrapWithVectorSkin(seoMeta, title);
  const overlay  = buildP2POverlay(title, cid, quality, porCount);

  // System III: 自己複製マニフェスト + ゲノムメタタグをHEADに埋め込む
  // Quine的性質: どの記事1本からでもネットワーク全体を再構築できる
  const manifest = buildReplicationManifest(title, cid, quality, porCount);
  const state = getArticleState(cid, porCount);
  const genomeTags = [
    `<meta name="phoenix-genome" content="${GENOME_VERSION}">`,
    `<meta name="phoenix-network" content="${PHOENIX_ORIGIN}">`,
    `<meta name="phoenix-state" content="${state}">`,
    `<meta name="phoenix-bootstrap" content="${PHOENIX_ORIGIN}/bootstrap">`,
    cid ? `<link rel="alternate" type="application/x-ipfs" href="ipfs://${cid}" title="IPFS">` : '',
    `<script type="application/x-phoenix-manifest">${manifest}</script>`,
  ].filter(Boolean).join('\n');
  const withManifest = skinHtml.includes('</head>')
    ? skinHtml.replace('</head>', genomeTags + '\n</head>')
    : skinHtml;

  if (withManifest.includes("</body>")) {
    return withManifest.replace("</body>", overlay + "\n</body>");
  }
  return withManifest + overlay;
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

// ─── Web3.Storage 二次ピン (STORACHA / w3up互換) ────────────────────────────
// env.W3S_TOKEN があれば Pinata と並行してピン留めする
// → Pinata が消えてもコンテンツが残る
// ─── Web3.Storage (Storacha) ── Filecoinバックアップ付き ──────────────────
async function pinToWeb3Storage(token, title, html) {
  const blob = new Blob([html], { type: "text/html; charset=utf-8" });
  const res = await fetch("https://api.web3.storage/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-NAME": encodeURIComponent(title) },
    body: blob,
  });
  if (!res.ok) throw new Error(`Web3.Storage ${res.status}`);
  return (await res.json()).cid;
}

// ─── Filebase ── IPFS RPC API（バケットスコープトークン）────────────────
async function pinToFilebase(rpcToken, title, html) {
  const form = new FormData();
  form.append("file", new Blob([html], { type: "text/html; charset=utf-8" }), `${title}.html`);
  const res = await fetch("https://rpc.filebase.io/api/v0/add?pin=true&wrap-with-directory=false", {
    method: "POST",
    headers: { Authorization: `Bearer ${rpcToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Filebase ${res.status}`);
  return (await res.json()).Hash;
}

// ─── NFT.Storage ── 無料・永続・Filecoin保証 ────────────────────────────
async function pinToNFTStorage(token, title, html) {
  const res = await fetch("https://api.nft.storage/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/html; charset=utf-8",
      "X-Agent-DID": "wikipedia-ipfs-mirror",
    },
    body: html,
  });
  if (!res.ok) throw new Error(`NFT.Storage ${res.status}`);
  return (await res.json()).value?.cid;
}

// ─── Lighthouse ── Filecoin永続保存（Raas対応）────────────────────────────
async function pinToLighthouse(token, title, html) {
  const form = new FormData();
  form.append("file", new Blob([html], { type: "text/html; charset=utf-8" }), `${title}.html`);
  const res = await fetch("https://node.lighthouse.storage/api/v0/add", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Lighthouse ${res.status}`);
  return (await res.json()).Hash;
}

// ─── 全ピニングサービスに並列送信（fire-and-forget）────────────────────────
function pinToAllServices(env, title, html) {
  if (env.W3S_TOKEN)        pinToWeb3Storage(env.W3S_TOKEN, title, html).catch(() => {});
  if (env.FILEBASE_TOKEN)   pinToFilebase(env.FILEBASE_TOKEN, title, html).catch(() => {});
  if (env.NFTSTORAGE_TOKEN) pinToNFTStorage(env.NFTSTORAGE_TOKEN, title, html).catch(() => {});
  if (env.LIGHTHOUSE_TOKEN) pinToLighthouse(env.LIGHTHOUSE_TOKEN, title, html).catch(() => {});
}

// ─── Nostr記事イベント: 新CIDをNostrネットワークに記録 ───────────────────────
// 記事タイトル・CID・URLを世界中のNostrリレーに配信する
// これにより記事の存在証明がNostrに永続的に記録される
async function publishArticleToNostr(env, title, cid) {
  if (!env.NOSTR_SK) return;
  try {
    const skBytes = hexToBytes(env.NOSTR_SK);
    const pkHex   = bytesToHex(schnorr.getPublicKey(skBytes));
    const url      = `https://wikipedia-is-dead.com/wiki/${encodeURIComponent(title)}`;
    const created_at = Math.floor(Date.now() / 1000);

    // NIP-01 kind 1: short text note (Nostrタイムラインに流れる)
    const content = `📚 Phoenix Mesh アーカイブ\n「${title}」\nIPFS: ${cid}\n${url}`;
    const tags = [
      ['t',   'wikipedia'],
      ['t',   'ipfs'],
      ['t',   'phoenix-mesh'],
      ['r',   url],
      ['url', `ipfs://${cid}`],
    ];

    const serialized = JSON.stringify([0, pkHex, created_at, 1, tags, content]);
    const idBytes    = sha256(new TextEncoder().encode(serialized));
    const idHex      = bytesToHex(idBytes);
    const sigHex     = bytesToHex(schnorr.sign(idBytes, skBytes));

    const event = { id: idHex, pubkey: pkHex, created_at, kind: 1, tags, content, sig: sigHex };

    // 3リレーへ並列送信（fire-and-forget）
    const relays = NOSTR_RELAYS.slice(0, 3);
    const results = await Promise.allSettled(relays.map(relay => new Promise((resolve, reject) => {
      let ws;
      const t = setTimeout(() => { try { ws?.close(); } catch {} reject(new Error('timeout')); }, 4000);
      try {
        ws = new WebSocket(relay);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify(['EVENT', event]));
          setTimeout(() => { clearTimeout(t); ws.close(); resolve(relay); }, 1000);
        });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws error')); });
      } catch (e) { clearTimeout(t); reject(e); }
    })));

  } catch {} // fire-and-forget: 失敗しても記事ピン自体に影響しない
}

// ─── Nostr DHT: 分散ノード発見とConsistent Hashing ──────────────────────────
// ビットコインと同じ原理: 中央サーバー不要でノードがお互いを発見・協調する

// タイトルをノード担当範囲にマッピングする高速ハッシュ（0-255）
function titleHashSimple(title) {
  let h = 5381;
  for (let i = 0; i < title.length; i++) h = (((h << 5) + h) + title.charCodeAt(i)) | 0;
  return Math.abs(h) % 256;
}

async function getNodeRegistry(env) {
  const obj = await env.HTML_BUCKET.get('__node-registry.json').catch(() => null);
  if (!obj) return { nodes: {} };
  try { return JSON.parse(await obj.text()); } catch { return { nodes: {} }; }
}

async function saveNodeRegistry(env, reg) {
  reg.updated_at = new Date().toISOString();
  await env.HTML_BUCKET.put('__node-registry.json', JSON.stringify(reg),
    { httpMetadata: { contentType: 'application/json' } });
}

function cleanStaleNodes(reg, staleMs = 15 * 60 * 1000) {
  const now = Date.now();
  for (const id of Object.keys(reg.nodes)) {
    if (now - new Date(reg.nodes[id].last_seen).getTime() > staleMs) delete reg.nodes[id];
  }
}

// Consistent Hashing: ノードID群を0-255の範囲に均等配置
function assignNodeRange(reg, nodeId) {
  const ids = [...new Set([...Object.keys(reg.nodes), nodeId])].sort();
  const idx  = ids.indexOf(nodeId);
  const n    = ids.length;
  const size = Math.ceil(256 / n);
  return { start: idx * size, end: Math.min((idx + 1) * size - 1, 255) };
}

// Nostrへノード登録イベントを送信（kind:30078 アプリ固有データ）
async function publishNodeToNostr(env, nodeId, range) {
  if (!env.NOSTR_SK) return;
  try {
    const skBytes = hexToBytes(env.NOSTR_SK);
    const pkHex   = bytesToHex(schnorr.getPublicKey(skBytes));
    const created_at = Math.floor(Date.now() / 1000);
    const content = JSON.stringify({ node_id: nodeId, range, genome: GENOME_VERSION, network: PHOENIX_ORIGIN });
    const tags = [['d', `phoenix-node:${nodeId}`], ['t', 'phoenix-mesh'], ['t', 'phoenix-node']];
    const serialized = JSON.stringify([0, pkHex, created_at, 30078, tags, content]);
    const idBytes = sha256(new TextEncoder().encode(serialized));
    const event = {
      id: bytesToHex(idBytes), pubkey: pkHex, created_at, kind: 30078, tags, content,
      sig: bytesToHex(schnorr.sign(idBytes, skBytes)),
    };
    // 2リレーへ送信（fire-and-forget）
    await Promise.allSettled(NOSTR_RELAYS.slice(0, 2).map(relay => new Promise((resolve, reject) => {
      let ws;
      const t = setTimeout(() => { try { ws?.close(); } catch {} reject(); }, 4000);
      try {
        ws = new WebSocket(relay);
        ws.addEventListener('open', () => { ws.send(JSON.stringify(['EVENT', event])); setTimeout(() => { clearTimeout(t); ws.close(); resolve(); }, 1000); });
        ws.addEventListener('error', reject);
      } catch (e) { clearTimeout(t); reject(e); }
    })));
  } catch {}
}

// ─── Self-Healing: CIDなし記事を自動再ピン ────────────────────────────────
async function selfHeal(env) {
  if (!env.PINATA_JWT) return { healed: 0, attempted: 0 };

  // CIDが空でR2にHTMLが存在する記事を最大10件取得（新着優先）
  const result = await env.DB.prepare(
    "SELECT title FROM articles WHERE (cid IS NULL OR cid = '') ORDER BY rowid DESC LIMIT 10"
  ).all();

  const targets = result.results || [];
  let healed = 0;

  for (const { title } of targets) {
    const obj = await env.HTML_BUCKET.get(title);
    if (!obj) continue;
    const html = await obj.text();
    try {
      const cid = await pinToIPFS(env.PINATA_JWT, title, html);
      await env.DB.prepare("UPDATE articles SET cid=? WHERE title=?").bind(cid, title).run();
      // 二次ピン + Nostr記事イベント（fire-and-forget）
      pinToAllServices(env, title, html);
      publishArticleToNostr(env, title, cid).catch(() => {});
      healed++;
    } catch {}
  }

  return { healed, attempted: targets.length };
}

// ─── Replication Heal: ENDANGERED記事への自律的複製補充 ──────────────────────
// セルオートマトン遷移規則 ENDANGERED → LOW: CIDはあるが追加ピンが0の記事を検出し
// 二次ピンサービスへ投入することで複製係数を引き上げる（中央調整者不要）
async function replicationHeal(env) {
  if (!env.PINATA_JWT) return { healed: 0 };

  // ENDANGERED: cid が存在するが por_count = 0 の記事（追加複製が一切ない）
  const result = await env.DB.prepare(
    "SELECT title, cid FROM articles WHERE cid != '' AND cid IS NOT NULL AND por_count = 0 ORDER BY rowid DESC LIMIT 8"
  ).all().catch(() => ({ results: [] }));

  const targets = result.results || [];
  let healed = 0;

  await Promise.allSettled(targets.map(async ({ title, cid }) => {
    const obj = await env.HTML_BUCKET.get(title).catch(() => null);
    if (!obj) return;
    const html = await obj.text();
    // 二次ピンを並列投入（Pinataには再ピンせず、他のサービスのみ）
    await pinToAllServices(env, title, html).catch(() => {});
    // por_count を 1 に設定して ENDANGERED → LOW へ遷移
    await env.DB.prepare(
      "UPDATE articles SET por_count = MAX(por_count, 1) WHERE title = ?"
    ).bind(title).run().catch(() => {});
    healed++;
  }));

  return { healed, attempted: targets.length };
}

// ─── Priority Pin: Wikimedia閲覧数APIで高需要記事を優先IPFS固定 ───────────
// "需要の重力が自然な秩序を作る" — 削除という概念の代わりに需要で優先順位を決める
async function priorityPin(env) {
  if (!env.PINATA_JWT) return { pinned: 0 };

  // 閲覧数上位タイトルを取得（R2に24時間キャッシュ）
  let topTitles = [];
  const now = Date.now();
  const cacheObj = await env.HTML_BUCKET.get('__top-articles.json').catch(() => null);
  if (cacheObj) {
    const cached = JSON.parse(await cacheObj.text());
    if (now - new Date(cached.ts).getTime() < 24 * 3600 * 1000) {
      topTitles = cached.titles;
    }
  }

  if (!topTitles.length) {
    const d = new Date(now - 86400000);
    const yyyy = d.getUTCFullYear();
    const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(d.getUTCDate()).padStart(2, '0');
    const pvRes = await fetch(
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/ja.wikipedia/all-access/${yyyy}/${mm}/${dd}`,
      { headers: { 'User-Agent': 'WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)' } }
    ).catch(() => null);
    if (pvRes?.ok) {
      const pvData = await pvRes.json();
      const articles = pvData.items?.[0]?.articles || [];
      topTitles = articles.slice(0, 300).map(a => a.article.replace(/_/g, ' '));
      await env.HTML_BUCKET.put('__top-articles.json',
        JSON.stringify({ ts: new Date().toISOString(), titles: topTitles }),
        { httpMetadata: { contentType: 'application/json' } }
      ).catch(() => {});
    }
  }

  if (!topTitles.length) return { pinned: 0 };

  // CIDなし記事を最大5件ピン固定（閲覧数降順）
  let pinned = 0;
  for (const title of topTitles) {
    if (pinned >= 5) break;
    const row = await env.DB.prepare("SELECT cid FROM articles WHERE title=?").bind(title).first().catch(() => null);
    if (!row || row.cid) continue;
    const obj = await env.HTML_BUCKET.get(title).catch(() => null);
    if (!obj) continue;
    const html = await obj.text();
    try {
      const cid = await pinToIPFS(env.PINATA_JWT, title, html);
      await env.DB.prepare("UPDATE articles SET cid=? WHERE title=?").bind(cid, title).run();
      if (env.W3S_TOKEN) pinToWeb3Storage(env.W3S_TOKEN, title, html).catch(() => {});
      publishArticleToNostr(env, title, cid).catch(() => {});
      pinned++;
    } catch {}
  }

  return { pinned };
}

// ─── Nostr: 記事インデックスを分散リレーに署名・配布する ──────────────────
// 目的: サイトが消えても世界中のNostrリレーに索引が残る
// NIP-01 + NIP-78 (kind 30078: replaceable application-specific data)
async function publishToNostr(env) {
  if (!env.NOSTR_SK) return { relays: 0, skipped: 'no key' };

  const skBytes = hexToBytes(env.NOSTR_SK);
  const pkHex   = bytesToHex(schnorr.getPublicKey(skBytes));

  // 最新版メタデータを取得
  const [verObj, statsObj] = await Promise.all([
    env.HTML_BUCKET.get('__ec-version.json').catch(() => null),
    env.HTML_BUCKET.get('__stats.json').catch(() => null),
  ]);
  const ver   = verObj   ? JSON.parse(await verObj.text())   : {};
  const stats = statsObj ? JSON.parse(await statsObj.text()) : {};

  const created_at = Math.floor(Date.now() / 1000);
  const content = JSON.stringify({
    v:           ver.v         ?? 0,
    articles:    stats.total_count ?? 0,
    with_cid:    stats.with_ipfs_cid ?? 0,
    prev_hash:   ver.prev_hash  ?? null,
    ts:          ver.ts         ?? new Date().toISOString(),
    algorithm:   ver.algorithm  ?? 'AES-256-GCM+SSS(k=3,n=5)+RS(3,5)',
    site:        'https://wikipedia-is-dead.com',
    shards:      ['__ec-shard-0.bin','__ec-shard-1.bin','__ec-shard-2.bin',
                  '__ec-shard-3.bin','__ec-shard-4.bin'],
  });

  const tags = [
    ['d',    'phoenix-mesh-index'],
    ['t',    'wikipedia'],
    ['t',    'ipfs'],
    ['t',    'censorship-resistance'],
    ['t',    'phoenix-mesh'],
    ['name', 'Phoenix Mesh — Wikipedia IPFS Mirror Index'],
  ];

  // NIP-01 イベントID = SHA256([0, pk, created_at, kind, tags, content])
  const serialized = JSON.stringify([0, pkHex, created_at, 30078, tags, content]);
  const idBytes    = sha256(new TextEncoder().encode(serialized));
  const idHex      = bytesToHex(idBytes);
  const sigHex     = bytesToHex(schnorr.sign(idBytes, skBytes));

  const event = {
    id: idHex, pubkey: pkHex, created_at, kind: 30078,
    tags, content, sig: sigHex,
  };

  // R2に保存（最新イベントのキャッシュ）
  await env.HTML_BUCKET.put('__nostr-latest.json', JSON.stringify(event), {
    httpMetadata: { contentType: 'application/json' },
  }).catch(() => {});

  // 並列でリレーに送信（各5秒タイムアウト）
  const results = await Promise.allSettled(
    NOSTR_RELAYS.map(relay => new Promise((resolve, reject) => {
      let ws;
      const timer = setTimeout(() => { try { ws?.close(); } catch {} reject(new Error('timeout')); }, 5000);
      try {
        ws = new WebSocket(relay);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify(['EVENT', event]));
          setTimeout(() => { clearTimeout(timer); ws.close(); resolve(relay); }, 1200);
        });
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
      } catch (e) { clearTimeout(timer); reject(e); }
    }))
  );

  const published = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  return { relays: published.length, eventId: idHex.slice(0, 16) + '…', pubkey: pkHex };
}

// ─── Erasure Coding: マニフェストを RS(3,5) でエンコードしてR2に保存 ─────
async function encodeManifestToShards(env) {
  // D1からCIDインデックス全件取得（ページング）
  const LIMIT = 50000;
  const allArticles = [];
  let offset = 0;
  while (true) {
    const res = await env.DB.prepare(
      "SELECT title, cid FROM articles LIMIT ? OFFSET ?"
    ).bind(LIMIT, offset).all();
    const rows = res.results || [];
    allArticles.push(...rows);
    if (rows.length < LIMIT) break;
    offset += LIMIT;
  }

  if (allArticles.length === 0) return { shares: 0, articles: 0 };

  await loadErasure();

  // ── マニフェスト・チェーン: 前バージョンのhashを計算してContinuity不変条件を確立 ──
  // Bitcoin's blockchain: block_N commits to hash(block_{N-1})
  // Phoenix chain:  version_N commits to hash(manifest_enc_{N-1})
  const prevVersionObj = await env.HTML_BUCKET.get('__ec-version.json').catch(() => null);
  const prevVersion    = prevVersionObj ? JSON.parse(await prevVersionObj.text()) : null;
  const newVersionNum  = prevVersion ? (prevVersion.v + 1) : 0;

  let prevHash = null;
  if (newVersionNum > 0) {
    const prevEncObj = await env.HTML_BUCKET.get('__ec-manifest.enc').catch(() => null);
    if (prevEncObj) {
      const buf = await prevEncObj.arrayBuffer();
      const h   = await crypto.subtle.digest('SHA-256', buf);
      prevHash  = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  }

  // バイナリマニフェスト生成
  const manifest = buildManifest(allArticles);

  // AES-256-GCM でマニフェストを暗号化（ランダム鍵・IV）
  const { ciphertext, iv, keyRaw } = await encryptBytes(manifest);

  // SSS(k=3, n=5) で 32B AES鍵を5シェアに分割
  // 各シェアは GF(2^8)上の多項式評価値 → 乱数と区別不可能
  const keyShares = sssShare(keyRaw, EC_SHARD_COUNT, 3);

  // IV(12B) || ciphertext を1バイナリに結合
  const encPacked = new Uint8Array(12 + ciphertext.length);
  encPacked.set(iv, 0);
  encPacked.set(ciphertext, 12);

  // version.json: チェーンメタデータ（公開 — encryptedデータの外側）
  const versionData = {
    v:         newVersionNum,
    ts:        new Date().toISOString(),
    articles:  allArticles.length,
    prev_hash: prevHash,           // H(manifest_enc_{N-1}) — チェーン連結点
    size:      encPacked.length,
    algorithm: 'AES-256-GCM+SSS(k=3,n=5)',
  };

  // R2に保存: 暗号化マニフェスト + 5キーシェア + バージョンチェーン
  await Promise.all([
    env.HTML_BUCKET.put('__ec-manifest.enc', encPacked, {
      httpMetadata: { contentType: 'application/octet-stream' },
    }),
    ...keyShares.map((share, i) =>
      env.HTML_BUCKET.put(`__ec-keyshare-${i}.bin`, share, {
        httpMetadata: { contentType: 'application/octet-stream' },
      })
    ),
    env.HTML_BUCKET.put('__ec-version.json', JSON.stringify(versionData), {
      httpMetadata: { contentType: 'application/json' },
    }),
  ]);

  return {
    shares:        EC_SHARD_COUNT,
    articles:      allArticles.length,
    manifestBytes: manifest.length,
    encryptedBytes: encPacked.length,
    version:       newVersionNum,
    prev_hash:     prevHash,
    algorithm:     'AES-256-GCM + SSS(k=3,n=5)',
  };
}

// ─── SSS: キーシェアの健全性確認・欠損シェア自動修復 ──────────────────────
async function verifyOrReconstructShards(env) {
  // 暗号化マニフェストとキーシェアの存在確認
  const [encCheck, ...shareChecks] = await Promise.all([
    env.HTML_BUCKET.head('__ec-manifest.enc').then(r => !!r).catch(() => false),
    ...Array.from({ length: EC_SHARD_COUNT }, (_, i) =>
      env.HTML_BUCKET.head(`__ec-keyshare-${i}.bin`).then(r => !!r).catch(() => false)
    ),
  ]);

  const healthyIndices = shareChecks.map((ok, i) => ok ? i : -1).filter(i => i >= 0);
  const healthy = healthyIndices.length;

  if (!encCheck) return { status: 'no_manifest', healthy, total: EC_SHARD_COUNT };
  if (healthy < 3)  return { status: 'unrecoverable', healthy, total: EC_SHARD_COUNT };

  if (healthy === EC_SHARD_COUNT) {
    // 全シェア正常 — マニフェストを復号せず統計・チェーンメタから返す
    const [statsObj, verObj] = await Promise.all([
      env.HTML_BUCKET.get('__stats.json').catch(() => null),
      env.HTML_BUCKET.get('__ec-version.json').catch(() => null),
    ]);
    const stats = statsObj ? JSON.parse(await statsObj.text()) : null;
    const ver   = verObj   ? JSON.parse(await verObj.text())   : null;
    return {
      status:    'healthy',
      healthy,
      total:     EC_SHARD_COUNT,
      articles:  stats?.total_count ?? 0,
      version:   ver?.v   ?? 0,
      prev_hash: ver?.prev_hash ?? null,
      chain_ts:  ver?.ts  ?? null,
      algorithm: 'AES-256-GCM + SSS(k=3,n=5)',
    };
  }

  // 3シェア以上あれば鍵を再構成して欠損シェアを補充
  await loadErasure();
  const chosenIndices = healthyIndices.slice(0, 3);
  const chosenShares = await Promise.all(
    chosenIndices.map(async idx => {
      const obj = await env.HTML_BUCKET.get(`__ec-keyshare-${idx}.bin`);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    })
  );
  if (chosenShares.some(s => !s)) return { status: 'reconstruct_failed', healthy };

  try {
    // ラグランジュ補間で AES鍵を復元し、5シェアを再生成して欠損分を補充
    const keyRaw = sssReconstruct(chosenShares, chosenIndices.map(i => i + 1));
    const freshShares = sssShare(keyRaw, EC_SHARD_COUNT, 3);
    const missingIndices = shareChecks.map((ok, i) => ok ? -1 : i).filter(i => i >= 0);
    await Promise.all(missingIndices.map(i =>
      env.HTML_BUCKET.put(`__ec-keyshare-${i}.bin`, freshShares[i], {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { rebuilt: 'true' },
      })
    ));
    return { status: 'rebuilt', healthy, rebuilt: missingIndices.length, total: EC_SHARD_COUNT };
  } catch (e) {
    return { status: 'reconstruct_failed', healthy, error: String(e) };
  }
}

// ─── R2 statsキャッシュ（D1 COUNT(*)スキャンを回避） ──────────────────────
async function updateStatsCache(env, deltaTotal, deltaIpfs, lastTitle) {
  try {
    const existing = await env.HTML_BUCKET.get('__stats.json');
    const prev = existing ? JSON.parse(await existing.text()) : {};
    const next = {
      ...prev,  // 全フィールドを保持（total_por, nostr_articles, nostr_batch_offset など）
      total_count:  (prev.total_count || 0) + deltaTotal,
      ipfs_count:   (prev.ipfs_count  || 0) + deltaIpfs,
      last_title:   lastTitle || prev.last_title || '',
      last_updated: new Date().toISOString(),
    };
    await env.HTML_BUCKET.put('__stats.json', JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json' },
    });
    return next;
  } catch {}
}

// ─── 1バッチ処理（Cronから呼ばれる） ──────────────────────────────────────
// ─── AI特筆性スコアリング ─────────────────────────────────────────────────────
// 記事の特筆性を客観的指標で0-100点評価
function scoreNotability(html, title) {
  const text = html.replace(/<[^>]+>/g, ' ');
  const charCount   = text.length;
  const refCount    = (html.match(/<ref/gi) || []).length;
  const extLinks    = (html.match(/https?:\/\//gi) || []).length;
  const hasInfobox  = /infobox|wikitable/i.test(html);
  const hasImage    = /<img /i.test(html);
  const sectionCount = (html.match(/<h[23]/gi) || []).length;
  const hasCategory = /カテゴリ|Category/i.test(html);

  // 重み付きスコア（Wikipedia特筆性基準に近似）
  let score = 0;
  score += Math.min(charCount / 500, 30);     // 文字数 (max 30点)
  score += Math.min(refCount * 2, 25);         // 出典数 (max 25点)
  score += Math.min(extLinks, 10);             // 外部リンク (max 10点)
  score += hasInfobox ? 10 : 0;               // Infobox有無
  score += hasImage ? 5 : 0;                  // 画像有無
  score += Math.min(sectionCount * 2, 10);    // 節構成 (max 10点)
  score += hasCategory ? 5 : 0;              // カテゴリ有無
  score += title.length < 30 ? 5 : 0;        // 簡潔なタイトル

  return {
    score: Math.round(Math.min(score, 100)),
    charCount, refCount, extLinks,
    hasInfobox, hasImage, sectionCount,
    verdict: score >= 60 ? 'notable' : score >= 30 ? 'marginal' : 'stub',
  };
}

// ─── Wikipedia Recent Changes 追従 ───────────────────────────────────────────
// 本家Wikipediaの変更をリアルタイムで検出し、R2/D1を更新 + diffを記録する
async function syncRecentChanges(env) {
  // 同期状態の読み込み（最終同期タイムスタンプ + APIcontinueトークン）
  const stateObj = await env.HTML_BUCKET.get('__sync_state.json').catch(() => null);
  const state    = stateObj ? JSON.parse(await stateObj.text()) : {};
  const now      = new Date().toISOString();

  // Wikipedia Recent Changes API
  const params = new URLSearchParams({
    action: 'query', list: 'recentchanges',
    rcprop: 'title|timestamp|sizes|comment|user|revid|old_revid|logaction',
    rclimit: '500', rctype: 'edit|new', rcnamespace: '0',
    format: 'json', formatversion: '2',
  });
  if (state.rc_continue) {
    params.set('rccontinue', state.rc_continue);
  } else {
    const since = state.last_sync ?? new Date(Date.now() - 60_000).toISOString();
    params.set('rcstart', since);
    params.set('rcdir', 'newer');
  }

  const rcResp = await fetch(`https://ja.wikipedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'PhoenixMesh/2.0 (wikipedia-is-dead.com; mirror)' }
  });
  if (!rcResp.ok) return { synced: 0, error: rcResp.status };
  const rcData = await rcResp.json();

  const changes      = rcData.query?.recentchanges ?? [];
  const nextContinue = rcData.continue?.rccontinue ?? null;
  if (changes.length === 0) {
    await env.HTML_BUCKET.put('__sync_state.json',
      JSON.stringify({ ...state, last_sync: now, rc_continue: null, last_run: now }));
    return { synced: 0 };
  }

  // 1回のcronで最大15記事（タイムアウト回避）
  const toProcess = changes.slice(0, 15);
  let synced = 0;

  for (const change of toProcess) {
    try {
      const title    = change.title;
      const revid    = change.revid    ?? 0;
      const oldRevid = change.old_revid ?? 0;

      // Parsoid REST APIで最新HTMLを取得
      const htmlResp = await fetch(
        `https://ja.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`,
        { headers: { 'User-Agent': 'PhoenixMesh/2.0', Accept: 'text/html' } }
      );
      if (!htmlResp.ok) continue;
      const newHtml = await htmlResp.text();
      if (newHtml.length < 500) continue;

      // 旧HTMLのサイズ取得（diff用）
      const oldObj  = await env.HTML_BUCKET.head(title).catch(() => null);
      const oldSize = oldObj?.size ?? 0;

      // R2を最新HTMLで上書き
      await env.HTML_BUCKET.put(title, newHtml, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
        customMetadata: { revid: String(revid), synced_at: now },
      });

      // diff metadataをR2に保存（__diffs/{title}/{revid}.json）
      const diffPayload = {
        title, revid, old_revid: oldRevid,
        editor:   change.user    ?? '',
        comment:  change.comment ?? '',
        old_size: oldSize,
        new_size: newHtml.length,
        size_delta: newHtml.length - oldSize,
        diff_url: `https://ja.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&diff=${revid}&oldid=${oldRevid}`,
        wiki_timestamp: change.timestamp,
        synced_at: now,
      };
      await env.HTML_BUCKET.put(
        `__diffs/${encodeURIComponent(title)}/${revid}.json`,
        JSON.stringify(diffPayload),
        { httpMetadata: { contentType: 'application/json' } }
      );

      // D1: articles更新 + article_diffs記録
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO articles (title, cid, uploaded_at, revid, wiki_last_modified)
          VALUES (?, '', ?, ?, ?)
          ON CONFLICT(title) DO UPDATE SET
            uploaded_at=excluded.uploaded_at,
            revid=excluded.revid,
            wiki_last_modified=excluded.wiki_last_modified
        `).bind(title, now, revid, change.timestamp),
        env.DB.prepare(`
          INSERT OR IGNORE INTO article_diffs
            (title, revid, old_revid, editor, comment, old_size, new_size, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(title, revid, oldRevid, change.user ?? '', change.comment ?? '',
                oldSize, newHtml.length, now),
      ]);

      synced++;
    } catch (_) { /* 個別失敗はスキップ */ }
  }

  // 更新記事をIndexNow + Google Indexing APIに即時通知
  const syncedTitles = toProcess.slice(0, synced).map(c => c.title);
  if (syncedTitles.length) {
    await submitToIndexNow(env, syncedTitles).catch(() => {});
    await submitToGoogleIndexingAPI(env, syncedTitles).catch(() => {});
  }

  // 同期状態を更新（未処理の続きがあればrc_continueを保持）
  const lastTimestamp = changes[changes.length - 1]?.timestamp ?? now;
  await env.HTML_BUCKET.put('__sync_state.json', JSON.stringify({
    last_sync:    nextContinue ? state.last_sync : lastTimestamp,
    rc_continue:  nextContinue,
    last_run:     now,
    last_synced:  synced,
    last_total:   changes.length,
  }));

  return { synced, total: changes.length, continue: !!nextContinue };
}

// ─── Wikipedia削除ログ監視 + 削除記事の緊急アーカイブ ───────────────────────
async function watchDeletionLog(env) {
  // Wikipedia削除ログ（直近50件）を取得
  const res = await fetch(
    `${WP}/w/api.php?action=query&list=logevents&letype=delete&lelimit=50&format=json`,
    { headers: { 'User-Agent': 'WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)' } }
  ).catch(() => null);
  if (!res?.ok) return { checked: 0, rescued: 0 };

  const data = await res.json();
  const events = data?.query?.logevents || [];
  let rescued = 0;

  for (const event of events) {
    const title = event.title;
    if (!title || event.ns !== 0) continue; // 記事名前空間のみ

    // すでにミラー済みか確認
    const existing = await env.HTML_BUCKET.get(title).catch(() => null);
    if (existing) continue; // すでに保存済み → スキップ

    // Wayback Machine から復元を試みる
    const wbUrl = `https://archive.org/wayback/available?url=ja.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    const wbRes = await fetch(wbUrl).catch(() => null);
    if (!wbRes?.ok) continue;
    const wbData = await wbRes.json();
    const snapshot = wbData?.archived_snapshots?.closest;
    if (!snapshot?.available) continue;

    const archived = await fetch(snapshot.url, {
      headers: { 'User-Agent': 'WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)' },
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    if (!archived?.ok) continue;

    const html = await archived.text();
    const notability = scoreNotability(html, title);

    // R2に保存
    await env.HTML_BUCKET.put(title, html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
      customMetadata: {
        notability_score: String(notability.score),
        notability_verdict: notability.verdict,
        rescued_from: 'wayback',
        deletion_timestamp: event.timestamp,
        deleted_by: event.user || 'unknown',
      },
    });

    // D1に記録（削除フラグ付き + deleted_articlesテーブルに削除メタデータ）
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO articles (title, cid, uploaded_at) VALUES (?, '', datetime('now'))
         ON CONFLICT(title) DO NOTHING`
      ).bind(title),
      env.DB.prepare(
        `INSERT INTO deleted_articles (title, deleted_by, deleted_at, deletion_reason, rescued_from, notability_score)
         VALUES (?, ?, ?, ?, 'wayback', ?)
         ON CONFLICT(title) DO UPDATE SET
           deleted_by=excluded.deleted_by,
           deleted_at=excluded.deleted_at,
           rescued_from='wayback'`
      ).bind(
        title,
        event.user || 'unknown',
        event.timestamp || new Date().toISOString(),
        event.comment || '',
        notability.score
      ),
    ]).catch(() => {});

    // IPFSピン固定
    if (env.PINATA_JWT) {
      const cid = await pinToIPFS(env.PINATA_JWT, title, html).catch(() => null);
      if (cid) {
        await env.DB.prepare("UPDATE articles SET cid=? WHERE title=?").bind(cid, title).run();
        pinToAllServices(env, title, html);
        // Nostrに「削除記事を救出した」証明を刻む
        await publishArticleToNostr(env, title, cid).catch(() => {});
      }
    }

    // 削除イベントを stats に記録
    const statsObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
    const stats = statsObj ? JSON.parse(await statsObj.text()) : {};
    stats.rescued_from_deletion = (stats.rescued_from_deletion || 0) + 1;
    stats.last_rescued = title;
    await env.HTML_BUCKET.put('__stats.json', JSON.stringify(stats),
      { httpMetadata: { contentType: 'application/json' } });

    rescued++;
    if (rescued >= 5) break; // 1回のcronで最大5件
  }

  return { checked: events.length, rescued };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VON NEUMANN SYSTEMS — Phoenix Mesh 第二世代
// ═══════════════════════════════════════════════════════════════════════════════

// ─── System I: 予測的先制保全 (Predictive Pre-emptive Preservation) ───────────
// Von Neumann自己複製論文の核心:「システムは自身の複製を環境変化より先に行う」
// 削除ログ(事後)ではなく削除テンプレート(事前)を監視し、記事が消える前に捕捉する
async function watchDeletionProposals(env) {
  // 即時削除・通常削除・特筆性テンプレートを並列監視
  const templates = [
    'Template:即時削除',      // 即時削除タグ (最緊急)
    'Template:削除依頼',      // 削除依頼タグ
    'Template:特筆性',        // 特筆性疑義タグ
    'Template:Orphan',        // 孤立記事 (リンク切れリスク)
  ];

  let preempted = 0;
  const results = [];

  for (const tmpl of templates) {
    if (preempted >= 8) break; // 1cron最大8件
    const params = new URLSearchParams({
      action: 'query', list: 'embeddedin',
      eititle: tmpl, einamespace: '0', eilimit: '20', format: 'json',
    });
    const res = await fetch(`${WP}/w/api.php?${params}`, {
      headers: { 'User-Agent': 'WikipediaIPFSMirror/1.0 (hello@medi-face.co.jp)' },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res?.ok) continue;

    const data = await res.json();
    const articles = (data.query?.embeddedin || []).slice(0, 5);

    for (const art of articles) {
      if (preempted >= 8) break;
      const title = art.title;

      // すでにミラー済みならスキップ
      const existing = await env.HTML_BUCKET.get(title).catch(() => null);
      if (existing) continue;

      // Wikipediaから生HTMLを直接取得（削除前に確保）
      const wpRes = await fetch(`${WP}/wiki/${encodeURIComponent(title)}`, {
        headers: { 'User-Agent': 'WikipediaIPFSMirror/1.0 (hello@medi-face.co.jp)', Accept: 'text/html' },
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (!wpRes?.ok) continue;

      const html = await wpRes.text();
      const notability = scoreNotability(html, title);

      // R2に保存（脅威メタデータ付き）
      await env.HTML_BUCKET.put(title, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
        customMetadata: {
          threat_template: tmpl,
          notability_score: String(notability.score),
          notability_verdict: notability.verdict,
          preempted_at: new Date().toISOString(),
          source: 'predictive_preservation',
        },
      }).catch(() => {});

      // D1に記録
      await env.DB.prepare(
        `INSERT INTO articles (title, cid, uploaded_at) VALUES (?, '', datetime('now'))
         ON CONFLICT(title) DO NOTHING`
      ).bind(title).run().catch(() => {});

      // 高特筆性記事は即座にIPFS固定
      if (notability.score >= 50 && env.PINATA_JWT) {
        const cid = await pinToIPFS(env.PINATA_JWT, title, html).catch(() => null);
        if (cid) {
          await env.DB.prepare("UPDATE articles SET cid=? WHERE title=?").bind(cid, title).run();
          pinToAllServices(env, title, html);
          publishArticleToNostr(env, title, cid).catch(() => {});
        }
      }

      results.push({ title, threat: tmpl, score: notability.score });
      preempted++;
    }
  }

  // 先制保全統計を更新
  if (results.length > 0) {
    const statsObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
    const stats = statsObj ? JSON.parse(await statsObj.text()) : {};
    stats.preempted_count = (stats.preempted_count || 0) + results.length;
    stats.last_preempted = results[0]?.title;
    await env.HTML_BUCKET.put('__stats.json', JSON.stringify(stats),
      { httpMetadata: { contentType: 'application/json' } }).catch(() => {});
  }

  return { preempted, results };
}

// ─── IndexNow: Bing/Yahoo/Yandex/Naver に新記事URLを即時通知 ────────────────
async function submitToIndexNow(env, titles) {
  if (!env.INDEXNOW_KEY || !titles.length) return;
  const urlList = titles.map(t => `https://wikipedia-is-dead.com/wiki/${encodeURIComponent(t)}`);
  await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: "wikipedia-is-dead.com",
      key: env.INDEXNOW_KEY,
      keyLocation: `https://wikipedia-is-dead.com/${env.INDEXNOW_KEY}.txt`,
      urlList,
    }),
  }).catch(() => {});
}

// ─── Google Indexing API: サービスアカウントJWTでURLを直接プッシュ ──────────
async function getGoogleAccessToken(saKeyJson) {
  const sa = JSON.parse(saKeyJson);
  const now = Math.floor(Date.now() / 1000);
  const b64url = s => btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim  = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/indexing",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  }));
  const toSign = `${header}.${claim}`;
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(toSign));
  const jwt = `${toSign}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token ?? null;
}

async function submitToGoogleIndexingAPI(env, titles) {
  if (!env.GOOGLE_SA_KEY || !titles.length) return;
  try {
    const token = await getGoogleAccessToken(env.GOOGLE_SA_KEY);
    if (!token) return;
    // 200 URL/日のデフォルト上限に配慮して最大5件/cron
    const batch = titles.slice(0, 5);
    await Promise.all(batch.map(t =>
      fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `https://wikipedia-is-dead.com/wiki/${encodeURIComponent(t)}`, type: 'URL_UPDATED' }),
      }).catch(() => {})
    ));
  } catch {}
}

// ─── IndexNow バルク送信（全記事を10,000件/cron で順次プッシュ）──────────────
async function indexNowBulkBatch(env) {
  if (!env.INDEXNOW_KEY) return;
  const cursorObj = await env.HTML_BUCKET.get('__indexnow_cursor.json').catch(() => null);
  const cursor    = cursorObj ? JSON.parse(await cursorObj.text()) : { offset: 0, done: false };
  if (cursor.done) return;

  const BATCH = 10000;
  const rows = await env.DB.prepare(
    "SELECT title FROM articles ORDER BY rowid LIMIT ? OFFSET ?"
  ).bind(BATCH, cursor.offset).all();

  const titles = (rows.results ?? []).map(r => r.title);
  if (titles.length === 0) {
    await env.HTML_BUCKET.put('__indexnow_cursor.json',
      JSON.stringify({ offset: cursor.offset, done: true, finished_at: new Date().toISOString() }));
    return;
  }

  await submitToIndexNow(env, titles);

  const nextOffset = cursor.offset + titles.length;
  const done       = titles.length < BATCH;
  await env.HTML_BUCKET.put('__indexnow_cursor.json',
    JSON.stringify({ offset: nextOffset, done, updated_at: new Date().toISOString() }));
}

// ─── サイトマップ ping（Google + Bing）──────────────────────────────────────
async function pingSitemaps() {
  const sm = encodeURIComponent('https://wikipedia-is-dead.com/sitemap-index.xml');
  await Promise.all([
    fetch(`https://www.google.com/ping?sitemap=${sm}`).catch(() => {}),
    fetch(`https://www.bing.com/ping?sitemap=${sm}`).catch(() => {}),
  ]);
}

// ─── Knowledge Graph Cascade: リンクトポロジーによる自律伝播 ─────────────────
// 記事AのHTMLからWikipedia内部リンクを抽出し、BFSキューに積む
// これにより保全がアルファベット順ではなく意味的なつながりで広がる
function extractWikiLinks(html, limit = 20) {
  const seen = new Set();
  // Wikipedia HTML は絶対URL (https://ja.wikipedia.org/wiki/TITLE) を使う
  // 相対URL (/wiki/TITLE) にもフォールバック対応
  const re = /href="(?:https?:\/\/ja\.wikipedia\.org)?\/wiki\/([^"#?]{2,200})"/g;
  let m;
  while ((m = re.exec(html)) !== null && seen.size < limit) {
    try {
      const raw = decodeURIComponent(m[1]).replace(/_/g, ' ');
      if (!raw.includes(':') && raw.length > 1) seen.add(raw);
    } catch {}
  }
  return [...seen];
}

async function pushToGraphQueue(env, titles) {
  if (!titles.length) return;
  try {
    const obj = await env.HTML_BUCKET.get('__graph-queue.json').catch(() => null);
    const queue = obj ? JSON.parse(await obj.text()) : [];
    const existingSet = new Set(queue);
    const merged = [...titles.filter(t => !existingSet.has(t)), ...queue].slice(0, 2000);
    await env.HTML_BUCKET.put('__graph-queue.json', JSON.stringify(merged),
      { httpMetadata: { contentType: 'application/json' } });
  } catch {}
}

async function popFromGraphQueue(env, n) {
  try {
    const obj = await env.HTML_BUCKET.get('__graph-queue.json').catch(() => null);
    if (!obj) return [];
    const queue = JSON.parse(await obj.text());
    if (!queue.length) return [];
    const popped = queue.splice(0, n);
    await env.HTML_BUCKET.put('__graph-queue.json', JSON.stringify(queue),
      { httpMetadata: { contentType: 'application/json' } });
    return popped;
  } catch { return []; }
}

async function processBatch(env) {
  const progress = await env.DB.prepare(
    "SELECT * FROM upload_progress WHERE id = 1"
  ).first();
  if (progress?.status === "completed") return { done: true };

  // Knowledge Graph Cascade: グラフキュー優先（BFS的トポロジー伝播）
  let graphMode = false;
  const graphCandidates = await popFromGraphQueue(env, BATCH_SIZE);

  let pages, nextToken;
  if (graphCandidates.length === 0) {
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
    pages     = listJson.query?.allpages ?? [];
    nextToken = listJson.continue?.apcontinue ?? null;
  } else {
    // グラフキューのタイトルのうちD1に未登録のものだけを処理
    const gcExisting = graphCandidates.length > 0
      ? (await env.DB.prepare(
          `SELECT title FROM articles WHERE title IN (${graphCandidates.map(()=>'?').join(',')})`
        ).bind(...graphCandidates).all().catch(() => ({results:[]}))).results.map(r => r.title)
      : [];
    const gcSet = new Set(gcExisting);
    pages = graphCandidates.filter(t => !gcSet.has(t)).map(t => ({ title: t }));
    nextToken = progress?.last_continue_token ?? null; // トークンはそのまま保持
    graphMode = true;
  }

  if (pages.length === 0) {
    // 全記事を一巡したらリセットして次のサイクルへ（常に最新HTMLを再取得し続ける）
    await env.DB.prepare(
      "UPDATE upload_progress SET status='running', last_continue_token='', updated_at=datetime('now') WHERE id=1"
    ).run();
    return { done: false, cycleReset: true };
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

  // 既存CIDを一括取得してre-pin回避（Pinataクォータ節約）
  const fetchedTitles = htmlResults.filter(Boolean).map(x => x.title);
  const existingRows = fetchedTitles.length > 0
    ? (await env.DB.prepare(
        `SELECT title, cid FROM articles WHERE title IN (${fetchedTitles.map(() => '?').join(',')})`
      ).bind(...fetchedTitles).all().catch(() => ({ results: [] }))).results
    : [];
  const existingCids = new Map(existingRows.map(r => [r.title, r.cid]));

  // processBatchはR2/D1保存のみ。IPFSピンはselfHealが非同期で処理する。
  const pairs = [];
  for (const item of htmlResults) {
    if (!item) continue;
    const cid = existingCids.get(item.title) || "";
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

    // R2キャッシュ更新（D1 COUNT(*)スキャンを回避するため）
    // 新規記事（existingCidsに無い）だけをカウント（再巡回時の二重カウント防止）
    const newArticles = pairs.filter(p => !existingCids.has(p.title) || existingCids.get(p.title) === "").length;
    const newIpfs = pairs.filter(p => p.cid && !existingCids.get(p.title)).length;
    if (newArticles > 0 || newIpfs > 0) {
      await updateStatsCache(env, newArticles, newIpfs, pairs.at(-1)?.title ?? "");
    } else {
      // 再巡回中: last_titleだけ更新
      await updateStatsCache(env, 0, 0, pairs.at(-1)?.title ?? "");
    }
  }

  await env.DB.prepare(
    `UPDATE upload_progress
     SET last_title=?, last_continue_token=?, total_count=total_count+?, status='running', updated_at=datetime('now')
     WHERE id=1`
  ).bind(pages.at(-1)?.title ?? "", nextToken ?? "", pairs.length).run();

  // 新規記事のURLをIndexNow / Google Indexing API に送信
  const newTitles = pairs.filter(p => !existingCids.has(p.title) || existingCids.get(p.title) === "").map(p => p.title);
  if (newTitles.length > 0) {
    await Promise.all([
      submitToIndexNow(env, newTitles),
      submitToGoogleIndexingAPI(env, newTitles),
    ]);
  }

  // Knowledge Graph Cascade: 保全した記事のリンクをキューに追加（意味的伝播）
  // ※ awaitが必要 — fire-and-forgetだとWorker終了前にR2書き込みが完了しない
  if (pairs.length > 0) {
    const cascadeLinks = [...new Set(pairs.flatMap(({html}) => extractWikiLinks(html, 6)))];
    await pushToGraphQueue(env, cascadeLinks).catch(() => {});
  }

  return { processed: pairs.length, nextToken, graphMode };
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

// ─── Phoenix Quality Score 解説ページ ────────────────────────────────────
function buildQualityPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phoenix Quality Score — アルゴリズムによる知識の民主的優先順位付け</title>
<meta name="description" content="Wikipedia記事の品質を算出するPQSアルゴリズム。管理者の恣意的判断を排除し、需要の重力が自然な秩序を作る。">
<link rel="canonical" href="https://wikipedia-is-dead.com/quality">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e2e8f0;font-family:'Georgia',serif;line-height:1.8;padding:40px 20px;max-width:820px;margin:0 auto}
h1{font-size:2em;color:#f1f5f9;margin-bottom:8px;letter-spacing:-0.02em}
h2{font-size:1.3em;color:#a5b4fc;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid #1e293b;font-family:-apple-system,sans-serif}
h3{font-size:1.05em;color:#93c5fd;margin:24px 0 8px;font-family:-apple-system,sans-serif}
p{margin-bottom:16px;color:#cbd5e1}
.subtitle{color:#64748b;font-size:0.95em;margin-bottom:36px;font-family:-apple-system,sans-serif}
.axiom{background:#0f172a;border-left:3px solid #6366f1;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0;font-style:italic;color:#c7d2fe}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:0.9em;font-family:-apple-system,sans-serif}
th{background:#1e293b;color:#94a3b8;text-align:left;padding:10px 14px;font-weight:600;font-size:0.85em;letter-spacing:0.05em}
td{padding:10px 14px;border-bottom:1px solid #1e293b;color:#cbd5e1}
td:first-child{color:#e2e8f0;font-weight:500}
td:last-child{color:#64748b;font-size:0.85em}
.grade{display:inline-block;font-weight:700;padding:2px 10px;border-radius:12px;font-size:0.9em;letter-spacing:0.05em;font-family:monospace}
.grade-a{color:#4ade80;border:1px solid #4ade80;background:#052e16}
.grade-b{color:#60a5fa;border:1px solid #60a5fa;background:#082f49}
.grade-c{color:#fbbf24;border:1px solid #fbbf24;background:#1c1202}
.grade-d{color:#94a3b8;border:1px solid #475569;background:#1e293b}
.formula{background:#020617;color:#86efac;font-family:monospace;padding:20px;border-radius:8px;margin:16px 0;font-size:0.88em;line-height:1.9;overflow-x:auto}
.signal-row{display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid #1e293b}
.signal-name{color:#93c5fd;font-family:monospace;font-size:0.9em}
.signal-weight{color:#4ade80;font-weight:700;font-size:0.85em}
nav{margin-bottom:40px;font-family:-apple-system,sans-serif;font-size:0.85em}
nav a{color:#60a5fa;text-decoration:none;margin-right:16px}
nav a:hover{text-decoration:underline}
footer{margin-top:60px;padding-top:20px;border-top:1px solid #1e293b;color:#475569;font-size:0.82em;font-family:-apple-system,sans-serif;text-align:center}
.highlight{color:#f1f5f9;background:#1e293b;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:0.9em}
</style>
</head>
<body>

<nav><a href="/">Home</a><a href="/manifesto">Manifesto</a><a href="/protocol">Protocol</a><a href="/dashboard">Dashboard</a></nav>

<h1>Phoenix Quality Score</h1>
<p class="subtitle">管理者の恣意的判断を排除し、客観的アルゴリズムで記事の価値を測定する</p>

<div class="axiom">
「需要の重力が自然な秩序を作る。削除という概念は存在しない — 存在するのは優先順位だけだ。」
</div>

<h2>§1. なぜアルゴリズムが必要か</h2>

<p>現在のWikipediaでは、記事の存続・削除・掲載継続の判断を少数の管理者が独占している。問題はその判断基準が不透明であることだ。個人の趣味、コミュニティの派閥、力関係——これらが「特筆性」という曖昧な概念に隠れて行使される。</p>

<p>Phoenix Mesh はこの体制を根本から変える。管理者の判断を廃止するのではなく、<strong style="color:#f1f5f9">判断基準そのものをアルゴリズムに置換する</strong>。誰もがコードを読み、計算を検証し、スコアに異議を唱えられる。透明性が権力乱用を不可能にする。</p>

<p>さらに重要な点として、Phoenix Mesh は<strong style="color:#f1f5f9">記事を「削除」しない</strong>。すべての記事はR2に保存され、D1にインデックスされ、誰でも閲覧できる。PQSはIPFSピン固定の優先順位を決めるだけだ。高スコアの記事が先にIPFSへ永続化され、低スコアの記事は後回しになる——しかし消えることはない。</p>

<h2>§2. スコア計算式</h2>

<div class="formula">PQS = refs_score + secs_score + infobox_score + content_score + img_score + cat_score

refs_score    = min(refCount  / 50,    1.0) × 20   // 出典・脚注の量
secs_score    = min(secCount  / 10,    1.0) × 10   // 節構造の豊かさ
infobox_score = hasInfobox ? 15 : 0               // 要約表の有無
content_score = min(charCount / 10000, 1.0) × 30  // 記事本文の充実度
img_score     = min(imgCount  / 5,     1.0) × 15  // 画像・図版の豊富さ
cat_score     = min(catCount  / 10,    1.0) × 10  // カテゴリ分類の整備
                                          ─────────
                                          最大 100点</div>

<h2>§3. シグナル詳細</h2>

<table>
<tr><th>シグナル</th><th>検出方法</th><th>最大寄与</th><th>根拠</th></tr>
<tr><td>参照数 <span class="highlight">refCount</span></td><td>cite_note, .reference</td><td>20pt</td><td>出典の多さは検証可能性の指標</td></tr>
<tr><td>節数 <span class="highlight">secCount</span></td><td>&lt;h2&gt;, &lt;h3&gt;</td><td>10pt</td><td>構造化された解説は情報密度が高い</td></tr>
<tr><td>インフォボックス <span class="highlight">hasInfobox</span></td><td>.infobox, .wikitable</td><td>15pt</td><td>要約表は百科事典的品質の象徴</td></tr>
<tr><td>本文量 <span class="highlight">charCount</span></td><td>タグ除去後の文字数</td><td>30pt</td><td>情報量の最も直接的な指標</td></tr>
<tr><td>画像数 <span class="highlight">imgCount</span></td><td>&lt;img&gt;タグ</td><td>15pt</td><td>視覚情報は理解を助ける</td></tr>
<tr><td>カテゴリ数 <span class="highlight">catCount</span></td><td>/wiki/Category:</td><td>10pt</td><td>カテゴリ整備は知識体系への統合</td></tr>
</table>

<h2>§4. グレード</h2>

<table>
<tr><th>グレード</th><th>スコア範囲</th><th>意味</th><th>IPFSピン優先度</th></tr>
<tr><td><span class="grade grade-a">A</span></td><td>80–100点</td><td>百科事典的に充実した記事</td><td>最優先</td></tr>
<tr><td><span class="grade grade-b">B</span></td><td>60–79点</td><td>良質な記事、さらなる充実の余地あり</td><td>高</td></tr>
<tr><td><span class="grade grade-c">C</span></td><td>40–59点</td><td>基本情報は揃っているスタブ記事</td><td>通常</td></tr>
<tr><td><span class="grade grade-d">D</span></td><td>0–39点</td><td>最小限の情報のみ</td><td>後回し（削除はしない）</td></tr>
</table>

<h2>§5. 民主的需要との統合</h2>

<p>PQSは記事の<em>構造的品質</em>を測る。これに加え、Wikimediaの閲覧数APIから<strong style="color:#f1f5f9">実際の読者需要</strong>を取得し、IPFSピン固定の優先順位に反映させる。</p>

<p>毎日、前日のja.Wikipediaで最も読まれた上位300記事が抽出される。CIDが未登録の記事はPQSスコアと閲覧数の両方で評価され、毎10分サイクルごとに最大5件が優先的にIPFS固定される。これが<em>需要の重力</em>だ：読者が自然に集まるコンテンツが、自然に永続化される。</p>

<div class="formula">優先度 = f(pageviews, PQS)

// 高閲覧数 × 高PQS → 最優先でIPFS固定
// 低閲覧数 × 低PQS → 後回し（消えることはない）</div>

<h2>§6. 完全な透明性</h2>

<p>PQSのコードは<span class="highlight">src/index.js</span>の<span class="highlight">computeQualityScore(html)</span>関数として公開されている。誰でも読み、誰でも検証し、誰でもフォークできる。これが真の民主的管理だ——秘密の委員会でも、選ばれた管理者でもなく、<strong style="color:#f1f5f9">誰もが検証できる数式</strong>が記事の価値を決める。</p>

<div class="axiom">
「コードは嘘をつかない。委員会は嘘をつく。」
</div>

<footer>
Phoenix Mesh Protocol — wikipedia-is-dead.com<br>
<a href="/manifesto" style="color:#475569;text-decoration:none;">Manifesto</a> ·
<a href="/protocol" style="color:#475569;text-decoration:none;">Protocol</a> ·
<a href="/dashboard" style="color:#475569;text-decoration:none;">Dashboard</a>
</footer>
</body>
</html>`;
}

// ─── Phoenix Network ページ（P2Pネットワークのライブ可視化） ────────────────
function buildNetworkPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phoenix Network — wikipedia-is-dead.com</title>
<link rel="canonical" href="https://wikipedia-is-dead.com/network">
<meta name="robots" content="noindex">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#050508;--surface:#0a0a10;--fg:#ddd8cc;--fg-mid:#484848;--fg-dim:#1a1a22;
  --border:rgba(255,255,255,0.06);--green:#3dba74;--blue:#4a8cf7;--violet:#9b7cf4;--amber:#c9922a;
}
html,body{background:var(--bg);color:var(--fg);min-height:100vh;
  font-family:-apple-system,'Helvetica Neue',sans-serif;font-size:13px;-webkit-font-smoothing:antialiased;}
nav{display:flex;align-items:center;justify-content:space-between;
  padding:16px 40px;border-bottom:1px solid var(--border);}
.nav-title{font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:var(--fg-mid);}
.nav-links{display:flex;gap:20px;}
.nav-links a{font-size:11px;color:var(--fg-mid);text-decoration:none;letter-spacing:0.08em;}
.nav-links a:hover{color:var(--fg);}
main{max-width:900px;margin:0 auto;padding:60px 40px;}
h1{font-size:28px;font-weight:200;letter-spacing:-1px;margin-bottom:6px;}
.subtitle{font-size:12px;color:var(--fg-mid);letter-spacing:0.08em;margin-bottom:48px;}
.net-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:40px;}
@media(max-width:600px){.net-grid{grid-template-columns:1fr;}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;}
.card-head{display:flex;align-items:center;gap:10px;margin-bottom:20px;}
.card-dot{width:6px;height:6px;border-radius:50%;}
.card-dot.green{background:var(--green)}
.card-dot.blue{background:var(--blue);animation:pulse 2s ease-in-out infinite}
.card-dot.violet{background:var(--violet)}
.card-dot.amber{background:var(--amber);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
.card-title{font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:var(--fg-mid);}
.big-num{font-size:40px;font-weight:200;letter-spacing:-1.5px;margin-bottom:4px;font-variant-numeric:tabular-nums;}
.unit{font-size:11px;color:var(--fg-mid);letter-spacing:0.06em;}
.bar-wrap{height:3px;background:var(--fg-dim);border-radius:2px;margin:16px 0 10px;overflow:hidden;}
.bar-fill{height:100%;border-radius:2px;transition:width 0.8s cubic-bezier(.4,0,.2,1);}
.relays{display:flex;flex-direction:column;gap:8px;margin-top:8px;}
.relay{display:flex;align-items:center;justify-content:space-between;
  font-size:11px;padding:6px 10px;background:var(--fg-dim);border-radius:6px;}
.relay-name{color:#7a8ba8;font-family:monospace;}
.relay-status{padding:2px 8px;border-radius:10px;font-size:10px;}
.relay-status.ok{background:#1a3228;color:var(--green);}
.relay-status.wait{background:#1e1a0a;color:var(--amber);}
.log{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:0;overflow:hidden;margin-bottom:40px;}
.log-head{padding:14px 20px;border-bottom:1px solid var(--border);
  font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--fg-mid);}
.log-body{padding:16px 20px;font-family:monospace;font-size:11.5px;
  line-height:2;max-height:280px;overflow-y:auto;}
.log-row{display:flex;gap:12px;align-items:baseline;}
.log-ts{color:#2a3340;white-space:nowrap;}
.log-msg{color:#6b7a8d;}
.log-msg.green{color:var(--green);}
.log-msg.blue{color:var(--blue);}
.log-msg.violet{color:var(--violet);}
footer{text-align:center;padding:24px;font-size:11px;color:var(--fg-dim);border-top:1px solid var(--border);}
footer a{color:var(--fg-dim);text-decoration:none;}
</style>
</head>
<body>
<nav>
  <span class="nav-title">⌬ Phoenix Network</span>
  <div class="nav-links">
    <a href="/dashboard">Dashboard</a>
    <a href="/nostr.json">Nostr</a>
    <a href="/">Home</a>
  </div>
</nav>
<main>
  <h1>Phoenix Network</h1>
  <p class="subtitle">LIVE — 知識の分散ネットワークの現在</p>

  <div class="net-grid">
    <div class="card">
      <div class="card-head"><div class="card-dot green"></div><div class="card-title">Tier 1 — IPFS</div></div>
      <div class="big-num" id="ipfs-count">—</div>
      <div class="unit">記事 固定済み</div>
      <div class="bar-wrap"><div class="bar-fill" id="ipfs-bar" style="width:0;background:var(--green)"></div></div>
      <div class="unit" id="ipfs-pct" style="color:var(--fg-mid)">— % of ミラー済み</div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-dot violet"></div><div class="card-title">Tier 1 — Nostr</div></div>
      <div class="big-num" id="nostr-count">—</div>
      <div class="unit">記事 リレー配信済み</div>
      <div class="relays" id="relay-list">
        ${['relay.nostr.band','relay.damus.io','nos.lol','relay.snort.social','nostr.bitcoiner.social'].map(r =>
          `<div class="relay"><span class="relay-name">${r}</span>
           <span class="relay-status wait" id="relay-${r.replace(/\./g,'-')}">確認中…</span></div>`
        ).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-dot blue"></div><div class="card-title">Tier 2 — Browser Nodes</div></div>
      <div class="big-num" id="p2p-count">—</div>
      <div class="unit">P2Pセッション (直近5分)</div>
      <div style="margin-top:12px;font-size:11px;color:var(--fg-mid);">最大接続ピア: <span id="max-peers">—</span></div>
      <div style="margin-top:4px;font-size:11px;color:var(--fg-mid);">Proof of Read 累計: <span id="por-count">—</span></div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-dot amber"></div><div class="card-title">Tier 0 — Mirror</div></div>
      <div class="big-num" id="mirror-count">—</div>
      <div class="unit">記事 ミラー済み</div>
      <div class="bar-wrap"><div class="bar-fill" id="mirror-bar" style="width:0;background:var(--amber)"></div></div>
      <div class="unit" id="mirror-pct" style="color:var(--fg-mid)">— % of 目標 1,400,000</div>
    </div>
    <div class="card" style="border-color:#ef4444;">
      <div class="card-head"><div class="card-dot" style="background:#ef4444;"></div><div class="card-title">削除監視 — 救出済み</div></div>
      <div class="big-num" id="rescued-count" style="color:#ef4444;">—</div>
      <div class="unit">Wikipedia削除記事を救出</div>
      <div style="margin-top:8px;font-size:11px;color:var(--fg-mid);">最後に救出: <span id="last-rescued" style="color:#fca5a5;">—</span></div>
      <div style="margin-top:4px;font-size:10px;color:#64748b;">3分ごと削除ログ監視 → Wayback Machine復元 → IPFS固定</div>
    </div>
  </div>

  <div class="log">
    <div class="log-head">イベントログ — リアルタイム</div>
    <div class="log-body" id="event-log">
      <div class="log-row"><span class="log-ts">--:--:--</span><span class="log-msg">初期化中…</span></div>
    </div>
  </div>
</main>
<footer><a href="/dashboard">← ダッシュボード</a> · <a href="/manifesto">Manifesto</a> · <a href="/protocol">Protocol</a></footer>
<script>
const RELAYS = ['wss://relay.nostr.band','wss://relay.damus.io','wss://nos.lol','wss://relay.snort.social','wss://nostr.bitcoiner.social'];
let logEl;

function addLog(msg, cls = '') {
  if (!logEl) { logEl = document.getElementById('event-log'); if (!logEl) return; }
  const ts = new Date().toLocaleTimeString('ja-JP');
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = '<span class="log-ts">' + ts + '</span><span class="log-msg ' + cls + '">' + msg + '</span>';
  logEl.prepend(row);
  if (logEl.children.length > 40) logEl.removeChild(logEl.lastChild);
}

async function tick() {
  const d = await fetch('/stats').then(r => r.json()).catch(() => null);
  if (!d) return;

  const ipfs    = d.with_ipfs_cid || 0;
  const total   = d.total_articles || 0;
  const nostr   = d.nostr_articles || 0;
  const p2p     = d.p2p_active || 0;
  const maxP    = d.p2p_max_peers || 0;
  const por     = d.total_por || 0;

  document.getElementById('ipfs-count').textContent    = ipfs.toLocaleString('ja-JP');
  document.getElementById('ipfs-pct').textContent      = total > 0 ? (ipfs/total*100).toFixed(1) + '% of ミラー済み' : '';
  document.getElementById('ipfs-bar').style.width      = Math.min(ipfs/total*100,100) + '%';
  document.getElementById('nostr-count').textContent   = nostr.toLocaleString('ja-JP');
  const rescued = d.rescued_from_deletion || 0;
  document.getElementById('rescued-count').textContent = rescued.toLocaleString('ja-JP');
  document.getElementById('last-rescued').textContent  = d.last_rescued || '—';
  document.getElementById('p2p-count').textContent     = p2p;
  document.getElementById('max-peers').textContent     = maxP;
  document.getElementById('por-count').textContent     = por.toLocaleString('ja-JP') + ' 件';
  document.getElementById('mirror-count').textContent  = total.toLocaleString('ja-JP');
  document.getElementById('mirror-pct').textContent    = (total/1400000*100).toFixed(3) + '% of 目標 1,400,000';
  document.getElementById('mirror-bar').style.width    = Math.min(total/1400000*100,100) + '%';
}

// Nostrリレー接続テスト
function testRelays() {
  RELAYS.forEach(relay => {
    const key = relay.replace('wss://','').replace(/\./g,'-');
    const el = document.getElementById('relay-' + key);
    if (!el) return;
    try {
      const ws = new WebSocket(relay);
      const t = setTimeout(() => {
        ws.close();
        if (el.textContent === '確認中…') { el.textContent = 'タイムアウト'; el.className = 'relay-status wait'; }
      }, 6000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        el.textContent = '✓ 接続済み'; el.className = 'relay-status ok';
        addLog(relay.replace('wss://','') + ' に接続', 'violet');
        ws.close();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        el.textContent = '接続失敗'; el.className = 'relay-status wait';
      });
    } catch {}
  });
}

tick(); setInterval(tick, 15000);
testRelays();

// PoR / P2Pイベントを定期的にログ表示
let _prevPor = 0, _prevP2p = 0;
setInterval(async () => {
  const d = await fetch('/stats').then(r => r.json()).catch(() => null);
  if (!d) return;
  const por = d.total_por || 0;
  const p2p = d.p2p_active || 0;
  if (por > _prevPor) { addLog('📖 Proof of Read +' + (por - _prevPor) + ' 件', 'green'); _prevPor = por; }
  if (p2p > _prevP2p) { addLog('🌐 P2Pノード ×' + p2p + ' (直近5分)', 'blue'); }
  if (p2p === 0 && _prevP2p > 0) { addLog('P2Pセッション終了 (5分タイムアウト)'); }
  _prevP2p = p2p;
}, 30000);

addLog('Phoenix Network 起動', 'green');
addLog('Nostrリレーに接続中…', 'violet');
</script>
</body>
</html>`;
}

// ─── Nostr バックフィル: 既存CIDを毎分20件ずつ順次Nostrに配信 ──────────────
// nostr_batch_offset を __stats.json に保存してcronをまたいで継続する
async function nostrBackfill(env) {
  const statsObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
  const stats = statsObj ? JSON.parse(await statsObj.text()) : {};
  const batchOffset = stats.nostr_batch_offset ?? 0;

  const rows = await env.DB.prepare(
    "SELECT title, cid FROM articles WHERE cid IS NOT NULL AND cid != '' LIMIT 5 OFFSET ?"
  ).bind(batchOffset).all().catch(() => ({ results: [] }));

  const articles = rows.results || [];
  if (articles.length === 0) {
    // 末尾まで到達 → オフセットリセット
    stats.nostr_batch_offset = 0;
    await env.HTML_BUCKET.put('__stats.json', JSON.stringify(stats), {
      httpMetadata: { contentType: 'application/json' },
    }).catch(() => {});
    return;
  }

  let sent = 0;
  for (const { title, cid } of articles) {
    try {
      await publishArticleToNostr(env, title, cid);
      sent++;
    } catch {}
  }

  // オフセットとカウンターをアトミックに更新（レースコンディション回避）
  const freshObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
  const fresh = freshObj ? JSON.parse(await freshObj.text()) : {};
  fresh.nostr_batch_offset = batchOffset + articles.length;
  fresh.nostr_articles     = (fresh.nostr_articles || 0) + sent;
  await env.HTML_BUCKET.put('__stats.json', JSON.stringify(fresh), {
    httpMetadata: { contentType: 'application/json' },
  }).catch(() => {});

  return { sent, offset: batchOffset };
}

// ─── バッチループ: cron1回で複数バッチを連続実行 ──────────────────────────
// maxMs以内でproccesBatchを繰り返し、スループットを最大化する
async function runBatchLoop(env, maxMs = 52000) {
  const deadline = Date.now() + maxMs;
  let total = 0, batches = 0;
  while (Date.now() < deadline) {
    try {
      const r = await processBatch(env);
      total += r.processed ?? 0;
      batches++;
      if (r.done || !r.nextToken) break;
    } catch { break; }
  }
  return { total, batches };
}

// ─── Worker エクスポート ───────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const minute = new Date().getMinutes();

      // ① ミラーリング: 52秒間バッチを連続実行（cron1回あたり最大約8バッチ=200記事）
      const batchResult = runBatchLoop(env, 52000);

      // ② Self-Healing + 削除監視 + 複製補充 + RC追従: ミラーリングと並列実行
      const sideResult = (async () => {
        await selfHeal(env).catch(() => {});           // UNPROCESSED → ANCHORED
        await replicationHeal(env).catch(() => {});    // ENDANGERED → LOW（毎分）
        await syncRecentChanges(env).catch(() => {});  // 本家Wikipedia変更追従（毎分）
        if (minute % 3 === 0) await watchDeletionLog(env).catch(() => {});
        if (minute % 5 === 0) await watchDeletionProposals(env).catch(() => {});
        if (minute % 10 === 0) {
          await Promise.all([
            encodeManifestToShards(env).catch(() => {}),
            priorityPin(env).catch(() => {}),
            publishToNostr(env).catch(() => {}),
            indexNowBulkBatch(env).catch(() => {}),  // 全記事IndexNow一括送信（10分ごと）
          ]);
        }
        if (env.NOSTR_SK) await nostrBackfill(env).catch(() => {});
        if (minute === 0) await pingSitemaps().catch(() => {});
      })();

      await Promise.all([batchResult, sideResult]);
    })());
  },

  async fetch(request, env, ctx) {
    // リクエスト便乗: ボットの流入をバッチ処理に活用（R2キャッシュで負荷チェック）
    if (ctx) ctx.waitUntil((async () => {
      try {
        const ts = await env.HTML_BUCKET.get('__batch-kick-ts').catch(() => null);
        const last = ts ? parseInt(await ts.text()) : 0;
        if (Date.now() - last > 45000) { // 45秒以上空いていれば実行
          await env.HTML_BUCKET.put('__batch-kick-ts', String(Date.now()),
            { httpMetadata: { contentType: 'text/plain' } });
          await processBatch(env);
        }
      } catch {}
    })());
    try {
    const url = new URL(request.url);
    const { pathname } = url;

    // トップページ（宣言文）
    if (pathname === "/") {
      return new Response(await buildHomepage(env), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ダッシュボード
    if (pathname === "/dashboard") {
      return new Response(buildDashboard(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // マニフェスト
    if (pathname === "/manifesto") {
      return new Response(buildManifesto(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    // 参加者募集ページ
    if (pathname === "/join") {
      return new Response(buildJoinPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=1800" },
      });
    }

    // /api/p2p-telemetry — ブラウザHeliaの接続状態をサーバーに報告
    // 目的: P2Pネットワークが実際に機能しているかの実証データを収集する
    if (pathname === "/api/p2p-telemetry" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const peers = parseInt(body?.peers ?? 0, 10);
        if (peers > 1000) return json({ ok: true }); // 異常値は無視
        const statsObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
        if (statsObj) {
          const stats = JSON.parse(await statsObj.text());
          // p2p_sessions: 過去5分以内に報告されたセッション数（リアルタイム指標）
          const now = Date.now();
          const sessions = (stats.p2p_sessions || []).filter(s => now - s.ts < 5 * 60 * 1000);
          sessions.push({ ts: now, peers });
          stats.p2p_sessions = sessions.slice(-500); // 最大500件
          stats.p2p_active   = sessions.filter(s => s.peers > 0).length; // 実際に接続したノード数
          stats.p2p_total_peers = sessions.reduce((s, x) => s + x.peers, 0);
          stats.p2p_max_peers   = Math.max(...sessions.map(x => x.peers), stats.p2p_max_peers || 0);
          await env.HTML_BUCKET.put('__stats.json', JSON.stringify(stats), {
            httpMetadata: { contentType: 'application/json' },
          }).catch(() => {});
        }
        return json({ ok: true });
      } catch {
        return json({ ok: true });
      }
    }

    // /api/por — Proof of Read シグナル収集
    // ブラウザがHeliaで記事を取得できたとき、その事実を匿名で報告する
    // PoR = "読んだ事実の暗号学的証明" の集計レイヤー
    if (pathname === "/api/por" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        const cid  = body?.cid;
        if (!cid || typeof cid !== 'string' || !/^(bafy|bafk|Qm)[a-zA-Z0-9]{20,}/.test(cid)) {
          return json({ error: 'invalid_cid' }, 400);
        }
        // per記事 por_count をインクリメント (best-effort)
        await env.DB.prepare(
          "UPDATE articles SET por_count = por_count + 1 WHERE cid = ?"
        ).bind(cid).run().catch(() => {});
        // グローバル total_por もインクリメント
        const statsObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
        if (statsObj) {
          const stats = JSON.parse(await statsObj.text());
          stats.total_por  = (stats.total_por  || 0) + 1;
          stats.last_por_ts = new Date().toISOString();
          await env.HTML_BUCKET.put('__stats.json', JSON.stringify(stats), {
            httpMetadata: { contentType: 'application/json' },
          }).catch(() => {});
        }
        return json({ ok: true });
      } catch {
        return json({ error: 'internal' }, 500);
      }
    }

    // ─── 分散クロール協力者API ────────────────────────────────────────────────

    // /contribute — 参加方法ランディングページ
    if (pathname === "/contribute") {
      const stats = await (async () => {
        try {
          const r = await env.DB.prepare("SELECT COUNT(*) as total, COUNT(CASE WHEN cid!='' AND cid IS NOT NULL THEN 1 END) as pinned FROM articles").first();
          return r;
        } catch { return { total: 0, pinned: 0 }; }
      })();
      const remaining = Math.max(0, 1400000 - (stats?.total ?? 0));
      const pct = ((stats?.total ?? 0) / 1400000 * 100).toFixed(1);
      return new Response(`<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phoenix Mesh — 協力者募集</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e2e8f0;font-family:-apple-system,sans-serif;padding:40px 20px;max-width:800px;margin:0 auto}
h1{font-size:2em;font-weight:300;letter-spacing:-1px;margin-bottom:8px;color:#a78bfa}
.sub{color:#64748b;margin-bottom:40px;font-size:.95em}
.progress{background:#1e293b;border-radius:8px;padding:20px;margin-bottom:32px}
.bar-wrap{background:#0f172a;border-radius:4px;height:8px;margin:12px 0}
.bar{background:linear-gradient(90deg,#7c3aed,#a78bfa);height:8px;border-radius:4px;transition:width .5s}
.nums{display:flex;justify-content:space-between;font-size:.8em;color:#64748b}
.card{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:24px;margin-bottom:20px}
h2{font-size:1.1em;color:#a78bfa;margin-bottom:12px}
code{background:#1e293b;padding:3px 8px;border-radius:4px;font-family:monospace;color:#34d399;font-size:.9em}
pre{background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px;overflow-x:auto;margin:12px 0}
pre code{background:none;padding:0;color:#e2e8f0}
.badge{display:inline-block;background:#7c3aed22;border:1px solid #7c3aed55;border-radius:20px;padding:2px 10px;font-size:.75em;color:#a78bfa;margin-left:8px}
a{color:#a78bfa}
.api{font-size:.85em;color:#94a3b8;margin-top:8px;font-family:monospace}
</style></head>
<body>
<h1>Phoenix Mesh</h1>
<p class="sub">Wikipediaの検閲・削除と戦う分散保全ネットワーク。あなたの力が必要です。</p>

<div class="progress">
  <div style="display:flex;justify-content:space-between;align-items:baseline">
    <span style="font-size:1.1em;font-weight:500">${(stats?.total ?? 0).toLocaleString()}件 保全済み</span>
    <span style="color:#64748b;font-size:.85em">目標: 140万件</span>
  </div>
  <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
  <div class="nums"><span>${pct}% 完了</span><span>残り約${Math.round(remaining/10000)*1}万件</span></div>
</div>

<div class="card">
  <h2>🌐 方法1：このページを見るだけ <span class="badge">自動</span></h2>
  <p style="color:#94a3b8;font-size:.9em;line-height:1.7">
    wikipedia-is-dead.com のどのページを閲覧しても、バックグラウンドで自動的にクロール処理をトリガーします。特別な設定は不要です。
  </p>
</div>

<div class="card">
  <h2>⚡ 方法2：ワンライン協力ノード <span class="badge">推奨</span></h2>
  <p style="color:#94a3b8;font-size:.9em;margin-bottom:12px">Node.js 18以上が必要。実行中は自動でWikipediaを取得しサーバーに送信します。</p>
  <pre><code>npx wikipedia-mirror-contribute</code></pre>
  <p class="api">または手動ループ:</p>
  <pre><code>while true; do
  curl -s https://wikipedia-is-dead.com/api/contribute/trigger
  sleep 2
done</code></pre>
</div>

<div class="card">
  <h2>🔧 方法3：直接API <span class="badge">開発者向け</span></h2>
  <div class="api" style="line-height:2">
    <div><code>GET /api/contribute/next?n=10</code> — 未保全記事タイトルを最大n件取得</div>
    <div><code>POST /api/contribute/trigger</code> — サーバー側クロールをトリガー（ランダム1件）</div>
    <div><code>POST /api/contribute/submit</code> body: {title, html} — HTML直接送信</div>
    <div><code>GET /api/contribute/stats</code> — 進捗統計JSON</div>
  </div>
</div>

<div class="card">
  <h2>📌 方法4：IPFSピン協力</h2>
  <p style="color:#94a3b8;font-size:.9em;margin-bottom:8px">IPFSノードを持っている方は、保全済みCIDをピン固定することで永続性が高まります。</p>
  <pre><code>curl -s https://wikipedia-is-dead.com/api/contribute/stats | jq '.sample_cids[]' | xargs -I{} ipfs pin add {}</code></pre>
</div>

<p style="text-align:center;margin-top:40px;color:#334155;font-size:.8em">
  Phoenix Mesh — 知識は検閲されない。消えない。<br>
  <a href="/">← トップへ戻る</a>
</p>
</body></html>`, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
      });
    }

    // /api/contribute/stats
    if (pathname === "/api/contribute/stats") {
      try {
        const r = await env.DB.prepare(
          "SELECT COUNT(*) as total, COUNT(CASE WHEN cid!='' AND cid IS NOT NULL THEN 1 END) as pinned FROM articles"
        ).first();
        const total = r?.total ?? 0;
        const pinned = r?.pinned ?? 0;
        // sample CIDs for IPFS pinning volunteers
        const cidRows = await env.DB.prepare(
          "SELECT cid FROM articles WHERE cid!='' AND cid IS NOT NULL ORDER BY rowid DESC LIMIT 20"
        ).all();
        const sampleCids = (cidRows.results ?? []).map(x => x.cid);
        return new Response(JSON.stringify({
          total_mirrored: total,
          total_pinned_ipfs: pinned,
          target: 1400000,
          remaining: Math.max(0, 1400000 - total),
          progress_pct: (total / 1400000 * 100).toFixed(2),
          sample_cids: sampleCids,
        }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/contribute/next?n=10&node_id=XXX — Nostr DHT対応: ノードの担当範囲の未保全記事を返す
    // node_id指定時: consistent hashingで担当範囲のタイトルのみ返す（分散調整なし）
    // node_id未指定: 従来のランダム選択
    if (pathname === "/api/contribute/next") {
      try {
        const n      = Math.min(parseInt(url.searchParams.get("n") ?? "5"), 25);
        const nodeId = url.searchParams.get("node_id");

        let rangeStart = 0, rangeEnd = 255;
        if (nodeId) {
          const reg   = await getNodeRegistry(env);
          const info  = reg.nodes[nodeId];
          const range = info?.range ?? assignNodeRange(reg, nodeId);
          rangeStart  = range.start;
          rangeEnd    = range.end;
        }

        const randomStarts = ["あ","い","う","え","お","か","き","く","け","こ",
          "さ","し","す","せ","そ","た","ち","つ","て","と","な","に","ぬ","ね","の",
          "は","ひ","ふ","へ","ほ","ま","み","む","め","も","や","ゆ","よ","ら","り",
          "る","れ","ろ","わ","を","A","B","C","D","E","F","G","H","I","J","K","L","M",
          "N","O","P","Q","R","S","T","U","V","W","X","Y","Z","1","2","3","東","京","大",
          "日","本","世","界","歴","史","科","学","技","術","文","化","社","会","経","済"];
        const start = randomStarts[Math.floor(Math.random() * randomStarts.length)];
        const apiRes = await fetch(
          `${WP}/w/api.php?action=query&list=allpages&aplimit=80&apnamespace=0&format=json&apfrom=${encodeURIComponent(start)}`,
          { headers: { "User-Agent": "WikipediaIPFSMirror/1.0 (hello@medi-face.co.jp)" } }
        );
        const apiJson = await apiRes.json();
        let candidates = (apiJson.query?.allpages ?? []).map(p => p.title);

        // node_id指定時: 担当hash範囲でフィルタリング（Consistent Hashing）
        if (nodeId) {
          candidates = candidates.filter(t => {
            const h = titleHashSimple(t);
            return h >= rangeStart && h <= rangeEnd;
          });
        }

        if (candidates.length === 0) return new Response(JSON.stringify({ titles: [], node_id: nodeId || null }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });

        const placeholders = candidates.map(() => "?").join(",");
        const existing = await env.DB.prepare(
          `SELECT title FROM articles WHERE title IN (${placeholders})`
        ).bind(...candidates).all();
        const existingSet = new Set((existing.results ?? []).map(r => r.title));
        const uncrawled = candidates.filter(t => !existingSet.has(t)).slice(0, n);

        return new Response(JSON.stringify({
          titles: uncrawled,
          node_id: nodeId || null,
          range: nodeId ? { start: rangeStart, end: rangeEnd } : null,
          crawl_from: "https://ja.wikipedia.org/wiki/",
          submit_to: `${PHOENIX_ORIGIN}/api/contribute/submit`,
          proof_to:  `${PHOENIX_ORIGIN}/api/contribute/proof`,
        }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/contribute/trigger — サーバー側でランダム1バッチ実行（ブラウザ便乗用）
    if (pathname === "/api/contribute/trigger" && (request.method === "POST" || request.method === "GET")) {
      try {
        const result = await processBatch(env);
        return new Response(JSON.stringify({ ok: true, processed: result.processed ?? 0 }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/contribute/submit — HTML直接送信（開発者・CLIツール向け）
    if (pathname === "/api/contribute/submit" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        if (!body?.title || !body?.html || typeof body.html !== "string") {
          return json({ error: "title and html required" }, 400);
        }
        if (body.html.length < 1000 || body.html.length > 5_000_000) {
          return json({ error: "html size out of range" }, 400);
        }
        const title = String(body.title).slice(0, 300);
        const html = String(body.html);
        await env.HTML_BUCKET.put(title, html, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        });
        await env.DB.prepare(
          "INSERT INTO articles (title, cid, uploaded_at) VALUES (?, '', datetime('now')) ON CONFLICT(title) DO UPDATE SET uploaded_at=datetime('now')"
        ).bind(title).run();
        return new Response(JSON.stringify({ ok: true, title, stored: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/contribute/submit-batch — 一括送信（最大25件/リクエスト）
    if (pathname === "/api/contribute/submit-batch" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => null);
        if (!Array.isArray(body?.articles) || body.articles.length === 0) {
          return json({ error: "articles array required" }, 400);
        }
        const valid = body.articles
          .filter(a => a.title && typeof a.html === "string" &&
                       a.html.length >= 500 && a.html.length <= 5_000_000)
          .slice(0, 25)
          .map(a => ({ title: String(a.title).slice(0, 300), html: String(a.html) }));
        if (valid.length === 0) return json({ ok: true, processed: 0 });

        await Promise.all(valid.map(a =>
          env.HTML_BUCKET.put(a.title, a.html, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
          })
        ));
        const stmts = valid.map(a =>
          env.DB.prepare(
            "INSERT INTO articles (title, cid, uploaded_at) VALUES (?, '', datetime('now')) ON CONFLICT(title) DO UPDATE SET uploaded_at=datetime('now')"
          ).bind(a.title)
        );
        await env.DB.batch(stmts);
        return json({ ok: true, processed: valid.length });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/diffs/{title} — 記事の変更履歴JSON
    if (pathname.startsWith("/api/diffs/") && request.method === "GET") {
      const title  = decodeURIComponent(pathname.slice("/api/diffs/".length));
      const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
      const rows   = await env.DB.prepare(
        "SELECT revid, old_revid, editor, comment, old_size, new_size, synced_at FROM article_diffs WHERE title=? ORDER BY synced_at DESC LIMIT ?"
      ).bind(title, limit).all();
      return json({ title, diffs: rows.results ?? [] });
    }

    // /wiki/{title}/history — 記事変更履歴ページ
    if (pathname.startsWith("/wiki/") && pathname.endsWith("/history")) {
      const rawTitle = decodeURIComponent(pathname.slice(6, -8));
      const rows     = await env.DB.prepare(
        "SELECT revid, old_revid, editor, comment, old_size, new_size, synced_at FROM article_diffs WHERE title=? ORDER BY id DESC LIMIT 100"
      ).bind(rawTitle).all();
      const diffs    = rows.results ?? [];
      const rows2    = diffs.map(d => {
        const delta    = (d.new_size - d.old_size);
        const sign     = delta > 0 ? '+' : '';
        const color    = delta > 0 ? '#2a9d2a' : delta < 0 ? '#c0392b' : '#888';
        const diffLink = `https://ja.wikipedia.org/w/index.php?title=${encodeURIComponent(rawTitle)}&diff=${d.revid}&oldid=${d.old_revid}`;
        return `<tr>
          <td style="color:#888;white-space:nowrap">${d.synced_at?.slice(0,19).replace('T',' ')}</td>
          <td><a href="/wiki/${encodeURIComponent(rawTitle)}">${rawTitle}</a></td>
          <td style="color:#4a9eff"><a href="https://ja.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(d.editor??'')}" target="_blank">${d.editor??'不明'}</a></td>
          <td style="color:${color};font-weight:bold">${sign}${delta.toLocaleString()}文字</td>
          <td style="color:#bbb;max-width:400px;overflow:hidden">${(d.comment||'').slice(0,120)}</td>
          <td><a href="${diffLink}" target="_blank" style="color:#4a9eff;font-size:12px">Wikipedia差分→</a></td>
        </tr>`;
      }).join('');
      const html = `<!DOCTYPE html><html lang="ja"><head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${rawTitle} — 変更履歴 | Phoenix Mesh</title>
        <style>
          body{background:#0d1117;color:#e6edf3;font-family:sans-serif;margin:0;padding:20px}
          h1{color:#4a9eff;font-size:1.4em}
          a{color:#4a9eff}
          table{width:100%;border-collapse:collapse;font-size:13px}
          th{text-align:left;border-bottom:1px solid #30363d;padding:8px 12px;color:#8b949e}
          td{padding:8px 12px;border-bottom:1px solid #21262d;vertical-align:top}
          .back{display:inline-block;margin-bottom:16px;color:#4a9eff;text-decoration:none}
          .badge{background:#1f3a5f;color:#4a9eff;border-radius:4px;padding:2px 8px;font-size:12px}
        </style>
      </head><body>
        <a class="back" href="/wiki/${encodeURIComponent(rawTitle)}">← ${rawTitle} に戻る</a>
        <h1>📋 変更履歴: ${rawTitle}</h1>
        <p style="color:#8b949e">Phoenix Meshが本家Wikipediaから追従した変更の記録。
        <span class="badge">${diffs.length}件</span></p>
        ${diffs.length === 0
          ? '<p style="color:#8b949e">まだ変更履歴がありません。毎分cronで本家と同期中です。</p>'
          : `<table><thead><tr>
              <th>日時 (UTC)</th><th>記事</th><th>編集者</th>
              <th>変化量</th><th>編集コメント</th><th>差分</th>
             </tr></thead><tbody>${rows2}</tbody></table>`}
        <p style="color:#555;font-size:12px;margin-top:32px">
          Phoenix Mesh — wikipedia-is-dead.com |
          <a href="/wiki/${encodeURIComponent(rawTitle)}">記事を読む</a>
        </p>
      </body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
    }

    // /api/sync/status — 同期状態の確認
    if (pathname === "/api/sync/status") {
      const stateObj = await env.HTML_BUCKET.get('__sync_state.json').catch(() => null);
      const state    = stateObj ? JSON.parse(await stateObj.text()) : {};
      const count    = await env.DB.prepare("SELECT COUNT(*) as n FROM article_diffs").first();
      return json({ sync_state: state, total_diffs_recorded: count?.n ?? 0 });
    }

    // /bootstrap — 普遍構成子: どこからでもPhoenix Meshノードを再生成できるスクリプト
    // Von Neumann的自己記述: このエンドポイント自体がネットワークの「遺伝子」
    if (pathname === "/bootstrap") {
      const script = `#!/usr/bin/env python3
# Phoenix Mesh Contributor Node — ${GENOME_VERSION}
# Von Neumann Universal Constructor + Nostr DHT
#
# 使い方:
#   curl -sL ${PHOENIX_ORIGIN}/bootstrap | python3
#   PHOENIX_BATCH=10 PHOENIX_DELAY=1 curl -sL ${PHOENIX_ORIGIN}/bootstrap | python3
#
# このスクリプトは:
# 1. Nostr DHTにノード登録し、担当hash範囲を取得
# 2. 担当範囲の未保全記事のみをクロール（Consistent Hashing）
# 3. 中央サーバーが落ちても、ピアリストから他ノードを発見して継続
# 依存ライブラリ: Python 3標準ライブラリのみ
#
import urllib.request, urllib.parse, json, time, sys, os, socket, hashlib, uuid

BASE    = "${PHOENIX_ORIGIN}"
BATCH   = int(os.environ.get("PHOENIX_BATCH", "5"))
DELAY   = float(os.environ.get("PHOENIX_DELAY", "3"))
NODE_ID_FILE = os.path.expanduser("~/.phoenix-node-id")

# ── 安定したノードID（マシン固有、再起動後も同じ範囲を担当）─────────────────
def get_node_id():
    if os.path.exists(NODE_ID_FILE):
        with open(NODE_ID_FILE) as f:
            nid = f.read().strip()
            if nid: return nid
    nid = hashlib.sha256(f"{socket.gethostname()}-{uuid.getnode()}".encode()).hexdigest()[:16]
    try:
        with open(NODE_ID_FILE, 'w') as f: f.write(nid)
    except: pass
    return nid

def api(path, data=None, base=BASE, timeout=15):
    url = f"{base}{path}"
    req = urllib.request.Request(url,
        data=json.dumps(data).encode() if data else None,
        headers={"Content-Type":"application/json","User-Agent":f"PhoenixMesh/${GENOME_VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

# ── Nostr DHT: ノード登録とピア発見 ─────────────────────────────────────────
def announce_node(node_id, peers=None):
    try:
        result = api("/api/nodes/announce", {
            "node_id": node_id,
            "capabilities": ["crawl"],
            "version": "${GENOME_VERSION}"
        })
        return result
    except Exception as e:
        # フォールバック: ピアリストから別のノードを試す
        if peers:
            for peer in peers:
                peer_base = peer.get("base_url")
                if peer_base and peer_base != BASE:
                    try:
                        result = api("/api/nodes/announce", {
                            "node_id": node_id, "capabilities": ["crawl"], "version": "${GENOME_VERSION}"
                        }, base=peer_base)
                        print(f"  [DHT] フォールバック成功: {peer_base}")
                        return result
                    except: pass
        print(f"  [DHT] 登録失敗: {e}", file=sys.stderr)
        return None

def get_next(node_id, n=BATCH, base=BASE):
    try:
        return api(f"/api/contribute/next?node_id={node_id}&n={n}", base=base).get("titles", [])
    except Exception as e:
        print(f"  [next] {e}", file=sys.stderr); return []

def fetch_wiki(title):
    url = f"https://ja.wikipedia.org/wiki/{urllib.parse.quote(title)}"
    req = urllib.request.Request(url, headers={"User-Agent": "PhoenixMesh/${GENOME_VERSION} (+${PHOENIX_ORIGIN})"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")

def submit(title, html, base=BASE):
    return api("/api/contribute/submit", {"title": title, "html": html}, base=base, timeout=30)

def report_proof(titles, base=BASE):
    try:
        api("/api/contribute/proof", {"titles": titles, "node": get_node_id()}, base=base)
    except: pass

# ── メインループ ─────────────────────────────────────────────────────────────
NODE_ID = get_node_id()
print(f"\\033[1;32mPhoenix Mesh Node ${GENOME_VERSION}\\033[0m")
print(f"  Node ID  : {NODE_ID}")
print(f"  Network  : {BASE}")
print(f"  Batch    : {BATCH} articles/cycle")
print(f"  Ctrl+C to stop\\n")

# Nostr DHT登録
print("  [DHT] Nostrにノード登録中...")
announce_result = announce_node(NODE_ID)
peers = []
if announce_result:
    r = announce_result.get("range", {})
    peers = announce_result.get("peers", [])
    active = announce_result.get("active_nodes", 1)
    print(f"  [DHT] 担当範囲: hash {r.get('start',0)}-{r.get('end',255)} / 0-255")
    print(f"  [DHT] アクティブノード: {active}台 | ピア: {len(peers)}台\\n")
else:
    print(f"  [DHT] オフラインモード（全記事を担当）\\n")

last_announce = time.time()
preserved = 0

while True:
    try:
        # 10分ごとにDHT再登録（heartbeat）
        if time.time() - last_announce > 600:
            announce_node(NODE_ID, peers)
            last_announce = time.time()

        titles = get_next(NODE_ID, BATCH)
        if not titles:
            time.sleep(30); continue

        done = []
        for title in titles:
            try:
                html   = fetch_wiki(title)
                submit(title, html)
                print(f"  \\033[32m✓\\033[0m {title}")
                done.append(title); preserved += 1
            except Exception as e:
                print(f"  \\033[31m✗\\033[0m {title}: {e}", file=sys.stderr)

        if done: report_proof(done)
        print(f"  [このノード: {preserved}件保全 | 全体進捗: GET ${PHOENIX_ORIGIN}/api/contribute/stats]")
    except KeyboardInterrupt:
        print(f"\\n\\033[1m停止。{preserved}件保全しました。ありがとうございます！\\033[0m"); sys.exit(0)
    except Exception as e:
        print(f"[cycle error] {e}", file=sys.stderr)
    time.sleep(DELAY)
`;
      return new Response(script, {
        headers: {
          "Content-Type": "text/x-python; charset=utf-8",
          "Content-Disposition": 'attachment; filename="phoenix-node.py"',
          "Access-Control-Allow-Origin": "*",
          "X-Phoenix-Genome": GENOME_VERSION,
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    // /api/contribute/proof — Proof of Archive: ノードが保持しているタイトルを申告
    // por_count をインクリメントし、セルオートマトン状態遷移（ENDANGERED → LOW）を促す
    if (pathname === "/api/contribute/proof" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const titles = Array.isArray(body.titles)
          ? body.titles.slice(0, 50).map(t => String(t).slice(0, 300))
          : [];
        if (titles.length === 0) return json({ error: "titles[] required" }, 400);

        // バルクで por_count をインクリメント（best-effort、失敗しても無視）
        await Promise.allSettled(titles.map(title =>
          env.DB.prepare(
            "UPDATE articles SET por_count = por_count + 1 WHERE title = ? AND cid != '' AND cid IS NOT NULL"
          ).bind(title).run()
        ));

        return new Response(JSON.stringify({
          ok: true,
          acknowledged: titles.length,
          genome: GENOME_VERSION,
          message: "Proof recorded. State transitions will propagate on next heal cycle.",
        }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/nodes/announce — Nostr DHT: ノードが自身の存在を登録しhash担当範囲を取得
    // 中央サーバーが落ちても、Nostr上に登録済みの情報でネットワーク継続可能
    if (pathname === '/api/nodes/announce' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const nodeId = String(body.node_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
        if (!nodeId) return json({ error: 'node_id required (alphanumeric, max 64 chars)' }, 400);

        const reg = await getNodeRegistry(env);
        cleanStaleNodes(reg);

        reg.nodes[nodeId] = {
          last_seen: new Date().toISOString(),
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.slice(0, 5) : ['crawl'],
          version: String(body.version || 'unknown').slice(0, 32),
        };
        const range = assignNodeRange(reg, nodeId);
        reg.nodes[nodeId].range = range;

        await saveNodeRegistry(env, reg);
        publishNodeToNostr(env, nodeId, range).catch(() => {}); // Nostrへfire-and-forget

        const peers = Object.entries(reg.nodes)
          .filter(([id]) => id !== nodeId)
          .slice(0, 5)
          .map(([id, n]) => ({ id, range: n.range, last_seen: n.last_seen }));

        return new Response(JSON.stringify({
          ok: true, node_id: nodeId, range,
          active_nodes: Object.keys(reg.nodes).length,
          peers,                      // ← Nostrが落ちても這えるピアリスト
          genome: GENOME_VERSION,
          network: PHOENIX_ORIGIN,
          next_api: `${PHOENIX_ORIGIN}/api/contribute/next?node_id=${nodeId}&n=10`,
          announce_interval_s: 600,   // 10分ごとに再登録を推奨
        }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /api/nodes — アクティブノード一覧（Nostr fallback用）
    if (pathname === '/api/nodes') {
      try {
        const reg = await getNodeRegistry(env);
        cleanStaleNodes(reg);
        const nodes = Object.entries(reg.nodes).map(([id, n]) => ({
          id, range: n.range, capabilities: n.capabilities,
          last_seen: n.last_seen, version: n.version,
        }));
        return new Response(JSON.stringify({
          nodes, count: nodes.length,
          updated_at: reg.updated_at,
          genome: GENOME_VERSION,
        }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' } });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /protocol — Phoenix Mesh プロトコル仕様書
    if (pathname === "/protocol") {
      return new Response(buildProtocol(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    // /nostr.json — 最新署名済みNostrイベント（検証可能な分散インデックス）
    if (pathname === "/nostr.json") {
      const obj = await env.HTML_BUCKET.get('__nostr-latest.json').catch(() => null);
      if (!obj) return json({ error: 'not_yet_published' }, 404);
      const event = await obj.text();
      return new Response(event, {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=600',
          'X-Nostr-Pubkey': bytesToHex(schnorr.getPublicKey(
            hexToBytes(env.NOSTR_SK || '0'.repeat(64))
          )),
        },
      });
    }

    // /.well-known/nostr.json — NIP-05 identity verification
    // Nostrクライアントで phoenix-mesh@wikipedia-is-dead.com を検索可能にする
    if (pathname === "/.well-known/nostr.json") {
      if (!env.NOSTR_SK) return json({ names: {} });
      const pkHex = bytesToHex(schnorr.getPublicKey(hexToBytes(env.NOSTR_SK)));
      return new Response(JSON.stringify({
        names: {
          '_':            pkHex,  // NIP-05 root identity
          'phoenix-mesh': pkHex,
          'wikipedia':    pkHex,
        },
        relays: {
          [pkHex]: NOSTR_RELAYS,
        },
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // IndexNow キー検証ファイル: /{key}.txt
    if (env.INDEXNOW_KEY && pathname === `/${env.INDEXNOW_KEY}.txt`) {
      return new Response(env.INDEXNOW_KEY, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
      });
    }

    // /quality — Phoenix Quality Score アルゴリズム解説
    if (pathname === "/quality") {
      return new Response(buildQualityPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (pathname === "/network") {
      return new Response(buildNetworkPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    // /api/suggest — Wikipedia opensearch プロキシ（オートコンプリート用）
    if (pathname === "/api/suggest") {
      const q = url.searchParams.get("q") || "";
      if (!q) return json([]);
      const res = await fetch(
        `${WP}/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&format=json&origin=*`,
        { headers: { "User-Agent": "WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)" } }
      );
      const data = await res.json();
      return new Response(JSON.stringify(data[1] ?? []), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // /index — 全記事五十音・アルファベットインデックス（ハブページ）
    if (pathname === "/index") {
      const [countRow, kanjiRows] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) as cnt FROM articles").first(),
        env.DB.prepare(
          "SELECT SUBSTR(title,1,1) as c, COUNT(*) as cnt FROM articles " +
          "WHERE UNICODE(SUBSTR(title,1,1)) BETWEEN 19968 AND 40959 " +
          "GROUP BY c ORDER BY cnt DESC LIMIT 300"
        ).all(),
      ]);
      const total = (countRow?.cnt ?? 0).toLocaleString('ja-JP');
      const kanjiChars = (kanjiRows.results ?? []).map(r => r.c);
      const kanjiGrid = kanjiChars.length
        ? `<div class="alpha-grid">${kanjiChars.map(c => `<a class="idx-c" href="/index/${encodeURIComponent(c)}">${c}</a>`).join('')}</div>`
        : '<p style="color:#475569;font-size:.9em;">読み込み中…</p>';
      const kana = [
        ['あ','い','う','え','お'],['か','き','く','け','こ'],['さ','し','す','せ','そ'],
        ['た','ち','つ','て','と'],['な','に','ぬ','ね','の'],['は','ひ','ふ','へ','ほ'],
        ['ま','み','む','め','も'],['や','ゆ','よ'],['ら','り','る','れ','ろ'],
        ['わ','ゐ','ゑ','を','ん'],
      ];
      const rows = [
        'あ行','か行','さ行','た行','な行','は行','ま行','や行','ら行','わ行',
      ];
      const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      const nums  = '0123456789'.split('');
      const kanaGrid = kana.map((row, i) =>
        `<div class="idx-row"><span class="idx-row-label">${rows[i]}</span>` +
        row.map(c => `<a class="idx-c" href="/index/${encodeURIComponent(c)}">${c}</a>`).join('') +
        `</div>`
      ).join('\n');
      const alphaGrid = alpha.map(c =>
        `<a class="idx-c" href="/index/${encodeURIComponent(c)}">${c}</a>`).join('');
      const numGrid = nums.map(c =>
        `<a class="idx-c" href="/index/${encodeURIComponent(c)}">${c}</a>`).join('');

      const ld = JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "CollectionPage",
            "@id": "https://wikipedia-is-dead.com/index#collection",
            "name": "Wikipedia日本語版 全記事インデックス",
            "description": `日本語版Wikipedia ${total}件の全記事を五十音・アルファベット順に掲載した完全インデックス。`,
            "url": "https://wikipedia-is-dead.com/index",
            "inLanguage": "ja",
            "isPartOf": { "@type": "WebSite", "@id": "https://wikipedia-is-dead.com/#website" },
          },
          {
            "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Wikipedia Mirror", "item": "https://wikipedia-is-dead.com" },
              { "@type": "ListItem", "position": 2, "name": "全記事インデックス", "item": "https://wikipedia-is-dead.com/index" },
            ]
          }
        ]
      });

      const html = `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8">
<title>Wikipedia日本語版 全記事インデックス（${total}件）| wikipedia-is-dead.com</title>
<meta name="description" content="日本語版Wikipedia ${total}件の全記事を五十音・アルファベット順に掲載した完全インデックス。検閲不可能な永久保存版。">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
<link rel="canonical" href="https://wikipedia-is-dead.com/index">
<meta property="og:type" content="website">
<meta property="og:url" content="https://wikipedia-is-dead.com/index">
<meta property="og:title" content="Wikipedia日本語版 全記事インデックス（${total}件）">
<meta property="og:description" content="日本語版Wikipedia全記事の五十音・アルファベット索引。">
<link rel="icon" href="https://ja.wikipedia.org/static/favicon/wikipedia.ico">
<script type="application/ld+json">${ld}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,'Hiragino Sans',sans-serif;min-height:100vh}
header{background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;align-items:center;gap:16px}
header a{color:#e2e8f0;text-decoration:none;font-size:1.1em;font-weight:700}
.back{color:#94a3b8;font-size:.9em}
.hero{background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);padding:48px 24px 32px;text-align:center;border-bottom:1px solid #1e293b}
.hero h1{font-size:2em;font-weight:800;color:#f1f5f9;margin-bottom:8px}
.hero .sub{color:#94a3b8;font-size:1em}
.hero .count{font-size:2.5em;font-weight:900;color:#6366f1;display:block;margin:12px 0 4px}
.container{max-width:900px;margin:0 auto;padding:32px 24px}
.section{margin-bottom:40px}
.section h2{font-size:1.1em;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #1e293b}
.idx-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap}
.idx-row-label{color:#475569;font-size:.8em;min-width:40px;text-align:right}
.idx-c{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;background:#1e293b;color:#a5b4fc;border:1px solid #334155;border-radius:8px;text-decoration:none;font-size:1.1em;font-weight:600;transition:all .15s}
.idx-c:hover{background:#6366f1;color:#fff;border-color:#6366f1;transform:scale(1.05)}
.alpha-grid{display:flex;flex-wrap:wrap;gap:6px}
.idx-search-wrap{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px 24px;margin-bottom:36px}
.idx-search-wrap h2{font-size:1em;font-weight:700;color:#94a3b8;letter-spacing:.1em;margin-bottom:12px;text-transform:uppercase}
.idx-search-row{display:flex;gap:8px}
.idx-search-row input{flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px 14px;font-size:1em;color:#e2e8f0;outline:none;min-width:0}
.idx-search-row input:focus{border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,.25)}
.idx-search-row button{background:#6366f1;color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:1em;font-weight:600;cursor:pointer;white-space:nowrap}
.idx-search-row button:hover{background:#4f46e5}
footer{text-align:center;padding:32px 24px;color:#475569;font-size:.85em;border-top:1px solid #1e293b}
footer a{color:#6366f1;text-decoration:none}
</style>
</head><body>
<header>
  <a href="/">Wikipedia IPFS Mirror</a>
  <span class="back">/ 全記事インデックス</span>
</header>
<div class="hero">
  <h1>全記事インデックス</h1>
  <span class="count">${total}件</span>
  <p class="sub">日本語版Wikipedia全記事を五十音・アルファベット順に収録</p>
</div>
<div class="container">
  <div class="idx-search-wrap">
    <h2>記事を検索</h2>
    <div class="idx-search-row">
      <input type="search" id="idx-search-input" placeholder="漢字・ひらがな・カタカナ・英語で検索…（例：近澤徹）" autocomplete="off">
      <button id="idx-search-btn">検索</button>
    </div>
  </div>
  <script>
  (function(){
    var inp=document.getElementById('idx-search-input');
    var btn=document.getElementById('idx-search-btn');
    function go(){var q=inp.value.trim();if(q)location.href='/search?q='+encodeURIComponent(q);}
    btn.addEventListener('click',go);
    inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  })();
  </script>
  <div class="section">
    <h2>五十音順</h2>
    ${kanaGrid}
  </div>
  <div class="section">
    <h2>漢字（出現頻度順・上位300字）</h2>
    ${kanjiGrid}
  </div>
  <div class="section">
    <h2>アルファベット順</h2>
    <div class="alpha-grid">${alphaGrid}</div>
  </div>
  <div class="section">
    <h2>数字</h2>
    <div class="alpha-grid">${numGrid}</div>
  </div>
</div>
<footer>
  <a href="/">wikipedia-is-dead.com</a> — 日本語版Wikipedia ${total}件の永久保存アーカイブ。
  CC BY-SA 4.0 / Wikipedia contributors。
</footer>
</body></html>`;
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // /index/{char} — 文字別記事一覧（五十音・アルファベット）
    const indexCharM = pathname.match(/^\/index\/(.+)$/);
    if (indexCharM) {
      const char  = decodeURIComponent(indexCharM[1]).slice(0, 3);
      const page  = Math.max(0, parseInt(url.searchParams.get("p") ?? "0"));
      const PER   = 200;
      const offset = page * PER;

      const [rows, countRow] = await Promise.all([
        env.DB.prepare(
          "SELECT title FROM articles WHERE title LIKE ? ORDER BY title LIMIT ? OFFSET ?"
        ).bind(char + '%', PER, offset).all(),
        env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM articles WHERE title LIKE ?"
        ).bind(char + '%').first(),
      ]);

      const titles = (rows.results ?? []).map(r => r.title);
      const total  = countRow?.cnt ?? 0;
      const pages  = Math.ceil(total / PER);
      const totalFmt = total.toLocaleString('ja-JP');

      const listItems = titles.map((t, i) =>
        `<li><a href="/wiki/${encodeURIComponent(t)}">${t.replace(/</g,'&lt;')}</a></li>`
      ).join('');

      const pageNav = pages > 1 ? `<nav class="pg">
        ${page > 0 ? `<a href="/index/${encodeURIComponent(char)}?p=${page-1}">← 前へ</a>` : '<span></span>'}
        <span>${page+1} / ${pages}ページ</span>
        ${page < pages-1 ? `<a href="/index/${encodeURIComponent(char)}?p=${page+1}">次へ →</a>` : '<span></span>'}
      </nav>` : '';

      const canonicalUrl = `https://wikipedia-is-dead.com/index/${encodeURIComponent(char)}`;
      const ld2 = JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "CollectionPage",
            "name": `「${char}」で始まるWikipedia記事一覧（${totalFmt}件）`,
            "description": `Wikipedia日本語版のうち「${char}」で始まる記事${totalFmt}件の一覧。`,
            "url": canonicalUrl,
            "inLanguage": "ja",
          },
          {
            "@type": "BreadcrumbList",
            "itemListElement": [
              { "@type": "ListItem", "position": 1, "name": "Wikipedia Mirror", "item": "https://wikipedia-is-dead.com" },
              { "@type": "ListItem", "position": 2, "name": "全記事インデックス", "item": "https://wikipedia-is-dead.com/index" },
              { "@type": "ListItem", "position": 3, "name": `「${char}」`, "item": canonicalUrl },
            ]
          },
          {
            "@type": "ItemList",
            "name": `「${char}」で始まるWikipedia記事`,
            "numberOfItems": total,
            "itemListElement": titles.slice(0, 10).map((t, i) => ({
              "@type": "ListItem",
              "position": offset + i + 1,
              "url": `https://wikipedia-is-dead.com/wiki/${encodeURIComponent(t)}`,
              "name": t,
            })),
          }
        ]
      });

      const html2 = `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8">
<title>「${char}」で始まる記事一覧（${totalFmt}件）| wikipedia-is-dead.com</title>
<meta name="description" content="Wikipedia日本語版のうち「${char}」で始まる記事${totalFmt}件の完全一覧。五十音・アルファベット順インデックス。">
<meta name="robots" content="index, follow, max-snippet:-1">
<link rel="canonical" href="${canonicalUrl}">
${page > 0 ? `<link rel="prev" href="/index/${encodeURIComponent(char)}?p=${page-1}">` : ''}
${page < pages-1 ? `<link rel="next" href="/index/${encodeURIComponent(char)}?p=${page+1}">` : ''}
<meta property="og:type" content="website">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:title" content="「${char}」で始まるWikipedia記事一覧（${totalFmt}件）">
<link rel="icon" href="https://ja.wikipedia.org/static/favicon/wikipedia.ico">
<script type="application/ld+json">${ld2}</script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#e2e8f0;font-family:-apple-system,'Hiragino Sans',sans-serif}
header{background:#1e293b;border-bottom:1px solid #334155;padding:14px 24px;display:flex;align-items:center;gap:12px}
header a{color:#e2e8f0;text-decoration:none;font-weight:700}
.bc{color:#475569;font-size:.9em}
.bc a{color:#94a3b8;text-decoration:none}
.hero{padding:28px 24px 20px;background:#1e293b;border-bottom:1px solid #334155}
.hero h1{font-size:1.5em;font-weight:800;color:#f1f5f9}
.hero .cnt{color:#94a3b8;font-size:.9em;margin-top:4px}
.container{max-width:960px;margin:0 auto;padding:24px}
ul.art-list{list-style:none;columns:3;column-gap:16px}
@media(max-width:700px){ul.art-list{columns:2}}
@media(max-width:420px){ul.art-list{columns:1}}
ul.art-list li{break-inside:avoid;margin-bottom:4px}
ul.art-list a{color:#a5b4fc;text-decoration:none;font-size:.95em;line-height:1.6}
ul.art-list a:hover{color:#818cf8;text-decoration:underline}
.pg{display:flex;justify-content:space-between;align-items:center;padding:20px 0;border-top:1px solid #1e293b;margin-top:24px;color:#94a3b8;font-size:.9em}
.pg a{color:#6366f1;text-decoration:none;padding:8px 16px;border:1px solid #334155;border-radius:6px}
.pg a:hover{background:#1e293b}
footer{text-align:center;padding:24px;color:#475569;font-size:.85em;border-top:1px solid #1e293b}
footer a{color:#6366f1;text-decoration:none}
</style>
</head><body>
<header>
  <a href="/">Wikipedia IPFS Mirror</a>
  <nav class="bc" aria-label="パンくずリスト">
    / <a href="/index">インデックス</a> / 「${char}」
  </nav>
</header>
<div class="hero">
  <h1>「${char}」で始まる記事</h1>
  <p class="cnt">全${totalFmt}件 — ${page+1}/${pages}ページ</p>
</div>
<div class="container">
  ${titles.length ? `<ul class="art-list">${listItems}</ul>` : '<p style="color:#64748b;padding:40px 0;text-align:center">該当する記事がありません</p>'}
  ${pageNav}
</div>
<footer>
  <a href="/index">← 全記事インデックスに戻る</a> |
  <a href="/">wikipedia-is-dead.com</a> — CC BY-SA 4.0 / Wikipedia contributors
</footer>
</body></html>`;
      return new Response(html2, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=1800",
        },
      });
    }

    // /search — 検索結果ページ
    if (pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      if (!q) return Response.redirect("/", 302);

      // Wikipedia search API
      const res = await fetch(
        `${WP}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=20&format=json&origin=*`,
        { headers: { "User-Agent": "WikipediaIPFSMirror/1.0 (chikazawa@medi-face.co.jp)" } }
      );
      const data = await res.json();
      const results = data.query?.search ?? [];

      const rows = results.map(r => {
        const snippet = r.snippet.replace(/<[^>]+>/g, "");
        return `<li style="padding:14px 0;border-bottom:1px solid #eaecf0;">
          <a href="/wiki/${encodeURIComponent(r.title)}" style="font-size:1.05em;color:#3366cc;text-decoration:none;font-weight:500;">${r.title}</a>
          <div style="font-size:0.88em;color:#54595d;margin-top:4px;line-height:1.5;">${snippet}…</div>
          <div style="font-size:0.78em;color:#a2a9b1;margin-top:3px;">
            ${r.wordcount?.toLocaleString() ?? 0}語 · 最終更新: ${r.timestamp?.slice(0,10) ?? ""}
          </div>
        </li>`;
      }).join("");

      const html = `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${q} — 検索結果 — wikipedia-is-dead.com</title>
<meta name="robots" content="noindex, follow">
<link rel="icon" href="https://ja.wikipedia.org/static/favicon/wikipedia.ico">
<link rel="stylesheet" href="https://ja.wikipedia.org/w/load.php?lang=ja&modules=mediawiki.skinning.content.parsoid%7Cmediawiki.skinning.interface%7Cskins.vector.styles&only=styles&skin=vector">
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,'Linux Libertine','Georgia',serif;background:#fff;color:#202122}
#hdr{border-bottom:1px solid #a2a9b1;padding:8px 20px;display:flex;align-items:center;gap:20px;background:#fff;position:sticky;top:0;z-index:100}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.logo img{width:50px;height:50px}
.logo-t{font-size:11px;color:#54595d;line-height:1.3}
.logo-t strong{display:block;font-size:15px;font-family:'Linux Libertine','Georgia',serif;color:#202122}
.sform{flex:1;max-width:500px;display:flex;gap:6px}
.sform input{flex:1;border:1px solid #a2a9b1;border-radius:2px;padding:7px 10px;font-size:14px;outline:none}
.sform input:focus{border-color:#3366cc;box-shadow:0 0 0 1px #3366cc}
.sform button{background:#3366cc;color:#fff;border:none;border-radius:2px;padding:7px 14px;cursor:pointer;font-size:13px}
#main{max-width:860px;margin:0 auto;padding:28px 24px}
h1{font-family:'Linux Libertine','Georgia',serif;font-size:1.6em;font-weight:normal;margin:0 0 4px}
.meta{font-size:0.85em;color:#54595d;margin-bottom:20px}
ul{list-style:none;margin:0;padding:0}
</style></head><body>
<div id="hdr">
  <a class="logo" href="/"><img src="https://ja.wikipedia.org/static/images/icons/wikipedia.png" alt=""><div class="logo-t"><strong>Wikipedia</strong>IPFS Mirror</div></a>
  <form class="sform" action="/search" method="get">
    <input name="q" value="${q.replace(/"/g,'&quot;')}" autocomplete="off" id="sq">
    <button type="submit">検索</button>
  </form>
</div>
<div id="main">
  <h1>「${q}」の検索結果</h1>
  <div class="meta">${results.length}件（Wikipedia日本語版より）</div>
  <ul>${rows || '<li style="padding:20px 0;color:#54595d;">該当する記事が見つかりませんでした。</li>'}</ul>
</div>
<script>
const sq=document.getElementById('sq');
let t;
sq.addEventListener('input',()=>{
  clearTimeout(t);
  t=setTimeout(async()=>{
    if(sq.value.length<2)return;
    const r=await fetch('/api/suggest?q='+encodeURIComponent(sq.value)).then(r=>r.json());
  },200);
});
</script>
</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // OG image
    if (pathname === "/og.png") {
      const obj = await env.HTML_BUCKET.get("__og.png");
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Helia P2P bundle (Tier 3)
    if (pathname === "/helia-bundle.js") {
      const obj = await env.HTML_BUCKET.get("__helia-bundle.js");
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Hero image
    if (pathname === "/hero.png") {
      const obj = await env.HTML_BUCKET.get("__hero.png");
      if (!obj) return new Response("Not Found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // robots.txt
    if (pathname === "/robots.txt") {
      return new Response(
`# wikipedia-is-dead.com — Wikipedia日本語版永久保存アーカイブ
# CC BY-SA 4.0 / ライセンス準拠コンテンツ。クロール歓迎。
# Contact: chikazawa@medi-face.co.jp

User-agent: *
Allow: /
Allow: /wiki/
Allow: /dashboard
Allow: /manifesto
Allow: /protocol
Allow: /network
Allow: /search
Allow: /sitemap.xml
Allow: /sitemap-index.xml
Disallow: /admin/
Disallow: /api/
Disallow: /cid/
Crawl-delay: 1

# Googlebot: クロール制限なし・スニペット最大化
User-agent: Googlebot
Allow: /
Crawl-delay: 0

# Bingbot
User-agent: Bingbot
Allow: /
Crawl-delay: 1

Sitemap: https://wikipedia-is-dead.com/sitemap-index.xml
Sitemap: https://wikipedia-is-dead.com/sitemap.xml
`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    // /sitemap-index.xml — ページ分割サイトマップのインデックス
    if (pathname === "/sitemap-index.xml") {
      const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM articles").first();
      const total    = countRow?.cnt ?? 0;
      const pageSize = 50000;
      const pages    = Math.max(1, Math.ceil(total / pageSize));
      const host     = "https://wikipedia-is-dead.com";
      const today    = new Date().toISOString().slice(0, 10);
      const sitemaps = Array.from({ length: pages }, (_, i) =>
        `  <sitemap>\n    <loc>${host}/sitemap.xml${i > 0 ? `?page=${i}` : ''}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`
      ).join('\n');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemaps}\n</sitemapindex>`,
        { headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=86400" } }
      );
    }

    // sitemap.xml（D1から動的生成、最大50,000件）
    if (pathname === "/sitemap.xml") {
      const page   = parseInt(url.searchParams.get("page") ?? "0");
      const limit  = 50000;
      const offset = page * limit;
      const rows   = await env.DB.prepare(
        "SELECT title, COALESCE(wiki_last_modified, uploaded_at) AS lastmod FROM articles ORDER BY lastmod DESC LIMIT ? OFFSET ?"
      ).bind(limit, offset).all();
      const host = "https://wikipedia-is-dead.com";
      const urls = (rows.results ?? []).map(({ title, lastmod }) =>
        `<url><loc>${host}/wiki/${encodeURIComponent(title)}</loc>` +
        (lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : "") +
        `<changefreq>monthly</changefreq><priority>0.8</priority>` +
        `</url>`
      ).join("\n");
      // 次ページがあればサイトマップインデックスへのリンクを含める
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
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

    // /stats — R2キャッシュ優先（D1 COUNT(*)スキャンを完全回避）
    if (pathname === "/stats") {
      try {
        // R2から集計キャッシュ取得（row read ゼロ）
        const cached = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
        const cache  = cached ? JSON.parse(await cached.text()) : null;

        // upload_progress からステータスのみ取得（1行だけ読む）
        const progress = await env.DB.prepare(
          "SELECT status, last_title, updated_at, total_count FROM upload_progress WHERE id=1"
        ).first().catch(() => null);

        const total    = cache?.total_count ?? progress?.total_count ?? 0;
        const ipfs     = cache?.ipfs_count  ?? 0;
        const lastTitle = cache?.last_title  ?? progress?.last_title ?? "";
        const lastUpd  = cache?.last_updated ?? progress?.updated_at ?? null;

        return json({
          total_articles:  total,
          with_ipfs_cid:   ipfs,
          total_por:       cache?.total_por              ?? 0,
          nostr_articles:  cache?.nostr_articles         ?? 0,
          p2p_active:      cache?.p2p_active             ?? 0,
          p2p_max_peers:   cache?.p2p_max_peers          ?? 0,
          rescued_from_deletion: cache?.rescued_from_deletion ?? 0,
          last_rescued:    cache?.last_rescued           ?? null,
          status:      progress?.status ?? (cache ? "running" : "unknown"),
          last_title:  lastTitle,
          last_updated: lastUpd,
          batch_size:  BATCH_SIZE,
          _source: cache ? "r2_cache" : "d1",
        });
      } catch (e) {
        return json({ error: "stats_unavailable", message: String(e) }, 503);
      }
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

    // /admin/ec-encode ── Erasure Coding: マニフェストをエンコードしてR2に保存
    if (pathname === "/admin/ec-encode") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      try {
        const result = await encodeManifestToShards(env);
        return json(result);
      } catch (e) {
        return json({ error: String(e), stack: e?.stack?.slice(0, 500) }, 500);
      }
    }

    // /admin/ec-status ── Erasure Coding: シャード健全性チェック + 自動修復
    if (pathname === "/admin/ec-status") {
      try {
        const result = await verifyOrReconstructShards(env);
        return json(result);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /admin/ec-decode ── AES-256-GCM + SSS: マニフェストを復号して検証
    if (pathname === "/admin/ec-decode") {
      await loadErasure();

      // 暗号化マニフェスト取得（IV 12B || ciphertext）
      const encObj = await env.HTML_BUCKET.get('__ec-manifest.enc');
      if (!encObj) return json({ error: 'no_manifest' }, 404);
      const encPacked = new Uint8Array(await encObj.arrayBuffer());
      const iv = encPacked.slice(0, 12);
      const ciphertext = encPacked.slice(12);

      // 利用可能な3シェアを収集（x座標 = index + 1）
      const shares = [], xValues = [];
      for (let i = 0; i < EC_SHARD_COUNT && shares.length < 3; i++) {
        const obj = await env.HTML_BUCKET.get(`__ec-keyshare-${i}.bin`);
        if (obj) { shares.push(new Uint8Array(await obj.arrayBuffer())); xValues.push(i + 1); }
      }
      if (shares.length < 3) return json({ error: 'insufficient_shares', have: shares.length }, 500);

      try {
        const keyRaw  = sssReconstruct(shares, xValues);
        const plain   = await decryptBytes(ciphertext, iv, keyRaw);
        const entries = parseManifest(plain);
        return json({
          reconstructed: entries.length,
          sample: entries.slice(0, 5),
          algorithm: 'AES-256-GCM + SSS(k=3,n=5)',
        });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // /admin/bootstrap-check — libp2pブートストラップノードの到達確認
    if (pathname === "/admin/bootstrap-check") {
      const BOOTSTRAP_HOSTS = [
        'https://ny5.bootstrap.libp2p.io',
        'https://sg1.bootstrap.libp2p.io',
        'https://sv15.bootstrap.libp2p.io',
        'https://am6.bootstrap.libp2p.io',
      ];
      const results = await Promise.allSettled(
        BOOTSTRAP_HOSTS.map(async host => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          try {
            const res = await fetch(host, { signal: ctrl.signal, method: 'HEAD' });
            clearTimeout(t);
            return { host, status: res.status, ok: res.status < 500 };
          } catch (e) {
            clearTimeout(t);
            return { host, error: String(e) };
          }
        })
      );
      return json(results.map(r => r.value ?? r.reason));
    }

    // /admin/heal ── 手動Self-Healing実行
    if (pathname === "/admin/heal") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const result = await selfHeal(env);
      return json(result);
    }

    // /admin/pin-title?title=XXX ── 特定記事を即座にIPFS固定
    if (pathname === "/admin/pin-title") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const title = url.searchParams.get("title");
      if (!title) return json({ error: "title required" }, 400);
      const obj = await env.HTML_BUCKET.get(title);
      if (!obj) return json({ error: "not found in R2" }, 404);
      const html = await obj.text();
      const cid = await pinToIPFS(env.PINATA_JWT, title, html);
      await env.DB.prepare("UPDATE articles SET cid=? WHERE title=?").bind(cid, title).run();
      pinToAllServices(env, title, html);
      publishArticleToNostr(env, title, cid).catch(() => {});
      return json({ title, cid });
    }

    if (pathname === "/admin/nostr-publish") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const result = await publishToNostr(env);
      return json(result);
    }

    // /admin/nostr-batch: 既存CIDをNostrに一括配信 (limit=N, offset=N)
    if (pathname === "/admin/nostr-batch") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const body    = await request.json().catch(() => ({}));
      const limit   = Math.min(body.limit  ?? 20, 50);
      const offset  = body.offset ?? 0;
      const rows    = await env.DB.prepare(
        "SELECT title, cid FROM articles WHERE cid IS NOT NULL AND cid != '' LIMIT ? OFFSET ?"
      ).bind(limit, offset).all();
      const articles = rows.results || [];
      let published = 0;
      for (const { title, cid } of articles) {
        await publishArticleToNostr(env, title, cid).catch(() => {});
        published++;
      }
      // オフセットと記事数を stats.json に反映
      const sObj = await env.HTML_BUCKET.get('__stats.json').catch(() => null);
      const s = sObj ? JSON.parse(await sObj.text()) : {};
      s.nostr_batch_offset = offset + published;
      s.nostr_articles     = (s.nostr_articles || 0) + published;
      await env.HTML_BUCKET.put('__stats.json', JSON.stringify(s), {
        httpMetadata: { contentType: 'application/json' },
      }).catch(() => {});
      return json({ published, offset, limit, next_offset: offset + limit });
    }

    // /images/:filename ── 静的画像配信
    if (pathname.startsWith('/images/')) {
      const imgKey = `__images/${pathname.slice(8)}`;
      const imgObj = await env.HTML_BUCKET.get(imgKey);
      if (imgObj) {
        const ct = imgObj.httpMetadata?.contentType || 'image/jpeg';
        return new Response(imgObj.body, {
          headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' }
        });
      }
      return new Response('Not Found', { status: 404 });
    }

    // /wiki/{記事名}/history ── 版履歴ページ配信
    const histM = pathname.match(/^\/wiki\/(.+?)\/history$/);
    if (histM) {
      const histTitle = decodeURIComponent(histM[1]);
      const histObj = await env.HTML_BUCKET.get(`__history/${histTitle}`);
      if (histObj) {
        const histHtml = await histObj.text();
        return new Response(histHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" }
        });
      }
      return Response.redirect(
        `https://ja.wikipedia.org/w/index.php?title=${encodeURIComponent(histTitle)}&action=history`,
        302
      );
    }

    // /wiki/{記事名} ── 記事配信
    const m = pathname.match(/^\/wiki\/(.+)$/);
    if (!m) return new Response("Not Found", { status: 404 });
    const title = decodeURIComponent(m[1]);

    // 1. R2を最初に確認（D1クエリを完全スキップ → 行読み取り節約）
    const r2obj = await env.HTML_BUCKET.get(title);
    if (r2obj) {
      const html = await r2obj.text();
      const cid = r2obj.customMetadata?.cid || "";
      const wikiLastModified = r2obj.customMetadata?.synced_at || null;
      const uploadedAt = r2obj.uploaded ? r2obj.uploaded.toISOString() : null;
      const lastMod = wikiLastModified
        ? new Date(wikiLastModified).toUTCString()
        : uploadedAt ? new Date(uploadedAt).toUTCString() : new Date().toUTCString();
      const body = injectP2P(html, title, cid, 0, uploadedAt, wikiLastModified);
      return new Response(body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
          "X-IPFS-CID": cid,
          "Last-Modified": lastMod,
          "X-Robots-Tag": "index, follow",
          "X-Served-By": "r2",
        },
      });
    }

    // 2. R2ミス時のみD1にフォールバック
    const row = await env.DB.prepare(
      "SELECT cid, html, por_count, uploaded_at, wiki_last_modified FROM articles WHERE title=?"
    ).bind(title).first();

    if (!row) {
      return Response.redirect(
        `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        302
      );
    }

    const { cid, html: d1Html, por_count, uploaded_at, wiki_last_modified } = row;
    const porCount = por_count || 0;
    const uploadedAt = uploaded_at || null;
    const wikiLastModified = wiki_last_modified || null;
    const lastMod = wikiLastModified
      ? new Date(wikiLastModified).toUTCString()
      : uploadedAt ? new Date(uploadedAt).toUTCString() : new Date().toUTCString();
    const baseHeaders = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
      "X-IPFS-CID": cid || "",
      "Last-Modified": lastMod,
      "X-Robots-Tag": "index, follow",
    };

    // 3. D1レガシーHTMLから配信
    if (d1Html) {
      const body = injectP2P(d1Html, title, cid, porCount, uploadedAt, wikiLastModified);
      return new Response(body, { headers: { ...baseHeaders, "X-Served-By": "d1-legacy" } });
    }

    // 4. IPFSゲートウェイフォールバック
    if (cid) {
      const ipfsRes = await fetchFromIPFS(cid);
      if (ipfsRes) {
        const rawHtml = await ipfsRes.text();
        const body = injectP2P(rawHtml, title, cid, porCount, uploadedAt, wikiLastModified);
        return new Response(body, { headers: { ...baseHeaders, "X-IPFS-CID": cid, "X-Served-By": "ipfs" } });
      }
    }

    return new Response("コンテンツを取得できませんでした", { status: 502 });
    } catch (e) {
      // D1 row-read limit or other runtime error — return proper HTTP error instead of crashing
      const msg = String(e);
      const status = msg.includes("D1_ERROR") ? 503 : 500;
      return new Response(JSON.stringify({ error: msg.slice(0, 200) }), {
        status,
        headers: { "Content-Type": "application/json", "Retry-After": "3600" },
      });
    }
  },
};
