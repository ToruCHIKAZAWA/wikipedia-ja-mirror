# P2P参加機能 実装ロードマップ

閲覧者自身がピン固定に寄与できるP2P対応の実装計画。

---

## Tier 1 — UIで参加を促す

閲覧者がワンクリックでピン留めできるボタンをページに追加する。

**実装内容:**
- 各記事ページの下部に CID 表示 + コピーボタン（現在は小テキストで表示済み）
- 「このページをIPFSにピン留めする」ボタン → Pinata の pinByHash API を呼び出す
- IPFS ノード利用者向けに `ipfs pin add <CID>` コマンドをワンクリックコピー

**難易度:** 低  
**必要なもの:** Worker の HTML 注入部分を更新するだけ

---

## Tier 2 — Service Worker で自動キャッシュ

閲覧したページをブラウザが自動的にキャッシュし、次の訪問者へ再配信する。

**実装内容:**
- `sw.js` Service Worker をページ訪問時に自動インストール
- 訪問した記事の CID と HTML を `Cache API` に保存
- 次回アクセス時はサーバーを経由せずブラウザキャッシュから返す
- 訪問済み CID のリストを `IndexedDB` で管理

**難易度:** 中  
**効果:** サーバー負荷軽減 + 閲覧者がキャッシュノードとして機能

---

## Tier 3 — Helia でブラウザを本物の IPFS ノード化（真のP2P）

閲覧者のブラウザ自体が IPFS ノードになり、WebRTC で他のブラウザと直接接続する。

**実装内容:**
- `@helia/verified-fetch` + WebRTC Transport をバンドル
- Service Worker 内で Helia ノードを起動
- 記事取得を IPFS DHT 経由の P2P で行う（ゲートウェイ不要）
- 閲覧するだけで自動的にセーダーになり、同じ記事を見た人同士で配信し合う
- CID の検証（ハッシュ照合）により改ざん検出が自動化される

**難易度:** 高  
**必要なもの:** Helia バンドル（`@helia/unixfs`, `@libp2p/webrtc` 等）、ビルドパイプライン

**参考ライブラリ:**
- https://github.com/ipfs/helia
- `@helia/verified-fetch`
- `@libp2p/webrtc`

---

## 実装順序

```
Tier 1（UIボタン）→ Tier 2（Service Worker）→ Tier 3（Helia P2P）
```

Tier 1 と 2 は Cloudflare Worker の HTML 注入で完結する。  
Tier 3 は別途ビルドパイプラインが必要になる。
