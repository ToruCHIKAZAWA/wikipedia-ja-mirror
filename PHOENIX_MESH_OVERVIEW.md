# Phoenix Mesh — Wikipedia永続保全システム 全貌解説書

> 「Wikipediaは死んだ。だが知識は死なない。」

---

## 目次

1. [プロジェクトの思想](#1-プロジェクトの思想)
2. [システム全体アーキテクチャ](#2-システム全体アーキテクチャ)
3. [Cloudflare Workers — 中枢神経](#3-cloudflare-workers--中枢神経)
4. [ストレージ三層構造](#4-ストレージ三層構造)
5. [Von Neumann自己増殖プロトコル](#5-von-neumann自己増殖プロトコル)
6. [Nostr DHT — 分散ノード発見](#6-nostr-dht--分散ノード発見)
7. [知識グラフ・カスケード](#7-知識グラフカスケード)
8. [Nakamoto係数ダッシュボード](#8-nakamoto係数ダッシュボード)
9. [Enterprise HTMLダンプ大量インポート](#9-enterprise-htmlダンプ大量インポート)
10. [完走記録と統計](#10-完走記録と統計)
11. [今後の展望](#11-今後の展望)

---

## 1. プロジェクトの思想

### なぜ作ったのか

Wikipediaは現在、単一の非営利法人（Wikimedia Foundation）が管理するサーバー群に依存している。これは以下のリスクを内包する：

- **政府による検閲・遮断**（中国・ロシア・トルコ等で実績あり）
- **財政難による閉鎖**（寄付に完全依存）
- **運営方針の変更**（コンテンツの書き換え・削除）
- **単一障害点**（DDoS、サーバー障害）

Phoenix Meshは「**Wikipediaが死んでも、知識は死なない**」という哲学のもと、日本語版Wikipedia全記事を検閲・削除・消滅が不可能な分散ネットワークに移植するプロジェクトである。

### ドメイン名の意味

`wikipedia-is-dead.com` — これは挑発でなく宣言だ。「中央集権型のWikipediaという形態は終わった。知識はもはや特定のサーバーに依存しない」という思想的ステートメント。

### Phoenix（不死鳥）の比喩

灰の中から蘇る不死鳥のように、どのサーバーが落ちても、どの政府が遮断しても、ネットワーク全体が自己修復・自己複製して知識を守り続ける。これがPhoenix Meshという名の由来である。

---

## 2. システム全体アーキテクチャ

```
【ユーザー】
     │
     ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Workers (Edge Computing)         │
│  wikipedia-is-dead.com                       │
│  ├── 記事配信（R2優先、D1フォールバック）       │
│  ├── cronバッチ（毎分: 新記事取得+IPFS修復）   │
│  ├── API群（submit/submit-batch/proof/nodes）  │
│  └── P2Pオーバーレイ（Nakamoto係数バッジ）     │
└──────────────┬──────────────────────────────┘
               │
     ┌─────────┴──────────┐
     ▼                    ▼
┌─────────┐        ┌─────────────┐
│  R2     │        │    D1       │
│ (HTML   │        │  (SQLite)   │
│  本体)  │        │  (メタ情報) │
└─────────┘        └─────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  IPFS / Pinata                              │
│  (コンテンツアドレス永続保存)               │
│  CIDベース：記事URLが変わっても内容は不変    │
└─────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Nostr リレーネットワーク                    │
│  (ノードレジストリ・P2Pメッセージング)       │
└─────────────────────────────────────────────┘
```

---

## 3. Cloudflare Workers — 中枢神経

### なぜCloudflare Workersか

- **エッジコンピューティング**：世界300以上のPoP（接触点）で動作。地理的な単一障害点がない
- **無サーバー**：物理マシンの管理不要、自動スケール
- **Paid プラン**：D1データベース 50億行/月（事実上無制限）、Workers無制限リクエスト

### 主要エンドポイント

| エンドポイント | メソッド | 機能 |
|---|---|---|
| `/wiki/{title}` | GET | 記事配信（R2→D1フォールバック） |
| `/api/contribute/submit` | POST | 記事1件アップロード |
| `/api/contribute/submit-batch` | POST | 記事最大25件一括アップロード |
| `/api/contribute/next` | GET | 次に保全すべき記事を返す |
| `/api/contribute/proof` | POST | Proof-of-Read記録 |
| `/api/nodes/announce` | POST | P2Pノード登録 |
| `/api/nodes` | GET | アクティブノード一覧 |
| `/bootstrap` | GET | 貢献者ノード起動スクリプト（自己記述） |

### cronスケジューラー（毎分実行）

```
scheduled handler（毎分）
├── processBatch()    — Wikipedia APIから新記事取得 → R2/D1保存
├── selfHeal()        — CIDなし記事を検出 → IPFSピン
└── replicationHeal() — por_count=0記事を検出 → 再ピン強化
```

### 記事配信フロー（R2優先設計）

```
リクエスト /wiki/東京
    │
    ▼
R2にオブジェクト存在？
    ├── YES → 即座に返す（x-served-by: r2）← D1クエリなし
    └── NO  → D1からCIDを取得 → IPFSゲートウェイ経由で返す
```

この設計により、D1の1日500万行クォータ問題を解決した。99%以上のリクエストがR2のみで完結する。

---

## 4. ストレージ三層構造

### Tier 1A: Cloudflare R2（主ストレージ）

- **バケット名**: `wikipedia-ja-html`
- **容量**: 無制限（使用量課金）
- **現在の保存量**: 約1,483,349記事のHTML
- **特徴**: エッジ配信、低レイテンシ、グローバル冗長

### Tier 1B: Cloudflare D1（メタデータ）

- **テーブル**: `articles (title, cid, por_count, uploaded_at)`
- **役割**: CIDマッピング、読者数カウント、統計
- **クエリ例**:
  ```sql
  SELECT COUNT(*) FROM articles WHERE cid != ''  -- IPFS済み件数
  SELECT title FROM articles ORDER BY RANDOM() LIMIT 30  -- ランダムバッチ
  ```

### Tier 1C: IPFS / Pinata（永続保存）

- **CIDv1**: コンテンツアドレス（内容が変わらない限りURLも変わらない）
- **ピンサービス**: Pinata（主）+ NFT.Storage / Filebase / Lighthouse（副）
- **意味**: Cloudflareが消えても、IPFSネットワークに記事が残る

### Nakamoto係数 N の計算

```
N = por_count（実際にIPFSで読まれた回数）+ 2（R2+Pinata確定分）
```

N ≥ 3: STABLE（安定保全）
N ≥ 7: ROBUST（堅牢）
N ≥ 10: IMMORTAL（不滅）

---

## 5. Von Neumann自己増殖プロトコル

### 思想的背景

ジョン・フォン・ノイマンは1940年代、「自己を複製できる機械」の理論を構築した（Universal Constructor）。鍵となる洞察：

> 「自己を複製する機械は、自分自身の完全な記述（ゲノム）を持たなければならない」

Phoenix Meshはこれをデジタルネットワークに適用した。

### Genome（遺伝子）の実装

```javascript
const GENOME_VERSION = 'v2.0.0';

function buildReplicationManifest() {
  return {
    genome: GENOME_VERSION,
    network: {
      origin: PHOENIX_ORIGIN,
      bootstrap: `${PHOENIX_ORIGIN}/bootstrap`,
      api: {
        submit: `${PHOENIX_ORIGIN}/api/contribute/submit`,
        next:   `${PHOENIX_ORIGIN}/api/contribute/next`,
        proof:  `${PHOENIX_ORIGIN}/api/contribute/proof`,
        nodes:  `${PHOENIX_ORIGIN}/api/nodes`,
      }
    },
    automaton_rules: {
      // Von Neumann細胞オートマトン規則のデジタル版
      UNPROCESSED: { action: 'fetch_and_store', priority: 1 },
      ENDANGERED:  { action: 'replicate',       priority: 2 },
      LOW:         { action: 'pin_ipfs',         priority: 3 },
      STABLE:      { action: 'verify',           priority: 4 },
      ROBUST:      { action: 'propagate',        priority: 5 },
      IMMORTAL:    { action: 'idle',             priority: 6 },
    }
  };
}
```

### /bootstrap エンドポイント（自己記述的再生）

このエンドポイントにアクセスすると、**ネットワーク全体を再生成できるPythonスクリプト**が返される。

```bash
curl -sL https://wikipedia-is-dead.com/bootstrap | python3
```

スクリプトの内容：
1. Nostr DHTにノード登録し、担当hash範囲を取得
2. 担当範囲の未保全記事のみをクロール（帯域の無駄がない）
3. 中央サーバーが落ちても、ピアリストから他ノードを発見して継続
4. 依存ライブラリ：Python標準ライブラリのみ

Von Neumannの普遍構成子と同じ原理：**このエンドポイント自体がネットワークの「遺伝子」**であり、どこからでも全体を再構築できる。

---

## 6. Nostr DHT — 分散ノード発見

### なぜNostrか

中央のノードレジストリサーバーがあれば、そこを攻撃すれば全ネットワークを麻痺できる。Nostrプロトコルを使うことで、ノード情報をリレーネットワークに分散保存する。

### Consistent Hashing（一貫性ハッシュ）

```javascript
function titleHashSimple(title) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) & 0xff;
  return h; // 0-255
}
```

各ノードは0〜255のhash範囲を割り当てられ、**自分の担当範囲の記事のみを保全**する。これにより：

- 記事が自動的にノード間で分散される
- 1ノードが落ちても他ノードがカバー
- ネットワーク拡大とともに負荷が自動分散

### ノード登録フロー

```
POST /api/nodes/announce
  {"node_id": "abc123", "url": "https://my-node.example.com"}
    │
    ▼
1. 既存ノード数に基づいてhash範囲を割り当て
2. Nostr kind:30078イベントとして公開
3. ピアリスト（他のアクティブノード）を返す
4. ハートビート失敗ノードは自動削除
```

---

## 7. 知識グラフ・カスケード

### 概念

Wikipediaの記事はハイパーリンクで相互接続されている。「東京」の記事を保全すれば、そこにリンクされた「渋谷」「新宿」「皇居」も自動的に次の保全対象となる。これが**知識グラフ・カスケード**だ。

### BFSキュー実装

```javascript
// R2に__graph-queue.jsonとして保存されるBFSキュー
async function pushToGraphQueue(env, titles) {
  const queue = await popFromGraphQueue(env, 0); // 現在のキューを取得
  const merged = [...new Set([...queue, ...titles])].slice(0, 5000);
  await env.HTML_BUCKET.put('__graph-queue.json', JSON.stringify(merged));
}

async function popFromGraphQueue(env, n) {
  const obj = await env.HTML_BUCKET.get('__graph-queue.json');
  const queue = obj ? JSON.parse(await obj.text()) : [];
  return n === 0 ? queue : queue.splice(0, n);
}
```

### processBatch()の動作

```
processBatch()（cronから毎分呼ばれる）
    │
    ├── 1. グラフキューに記事あり？
    │       YES → そのタイトルをクロール対象に
    │       NO  → Wikipedia allpages APIからランダム取得
    │
    ├── 2. 各記事のHTML取得（並列）
    │
    ├── 3. R2に保存 + D1にINSERT
    │
    └── 4. 記事内のリンクを抽出 → グラフキューに追加（await）
              └── extractWikiLinks()
                    絶対URL対応: href="https://ja.wikipedia.org/wiki/TITLE"
```

---

## 8. Nakamoto係数ダッシュボード

### 概念

Nakamoto係数とはブロックチェーン分野の指標で「ネットワークを支配するのに必要な最小ノード数」を表す。値が高いほど分散化・堅牢性が高い。

Phoenix MeshではこれをIPFS普及度の指標として転用した。

### 記事ごとの状態分類

```javascript
function getArticleState(cid, porCount) {
  if (!cid)          return 'UNPROCESSED'; // まだIPFSにない
  if (porCount <= 0) return 'ENDANGERED';  // IPFSにあるが読者ゼロ
  if (porCount <= 2) return 'LOW';         // 読者少ない
  if (porCount <= 6) return 'STABLE';      // 安定
  if (porCount <= 9) return 'ROBUST';      // 堅牢
  return 'IMMORTAL';                       // 不滅
}
```

### 記事ページのバッジ表示

各記事ページの右下に7セグメントバーで表示：

```
N = por_count + 2（R2+Pinata確定分）

[██████░] N=6 STABLE   ← 緑
[███░░░░] N=3 LOW      ← 黄
[█░░░░░░] N=1 ENDANGERED ← 赤
```

### Proof-of-Read

読者が記事を読むと自動的に `por_count` がインクリメントされる。これは「この記事は実際に読まれている＝価値がある＝保全優先度が高い」という証明になる。

---

## 9. Enterprise HTMLダンプ大量インポート

### 背景と動機

通常のcronバッチ（毎分30件）では140万記事を全て取得するのに**約32日**かかる計算だった。

Wikimediaが提供する**Enterprise HTML Dump**（Parsoidレンダリング済みHTML）を使えば、APIを叩かずに全記事を一括取得できる。

### ダンプの仕様

```
URL: https://dumps.wikimedia.org/other/enterprise_html/runs/20250320/
     jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz

形式: tar.gz内にNDJSON（1行1記事）
構造: {"name": "東京", "article_body": {"html": "<html>..."}}
ファイル構成: jawiki_namespace_0_0.ndjson 〜 jawiki_namespace_0_71.ndjson（72ファイル）
各ファイル: 約2GB（展開後）
総展開サイズ: 約147GB
圧縮サイズ: 27.4GB
```

### dump_import.py v2 の設計

```python
DUMP_URL   = "https://dumps.wikimedia.org/.../jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz"
SUBMIT_URL = "https://wikipedia-is-dead.com/api/contribute/submit"
EXISTING   = "/tmp/existing_titles.txt"       # 重複除外リスト
DONE_FILE  = "/tmp/phoenix_done_this_run.txt" # 今回アップ済み（再接続用）
WORKERS    = 50                               # 並列スレッド数
MAX_RECONN = 10                               # 最大再接続回数
```

**核心的工夫**：`tarfile.open(fileobj=resp, mode="r|gz")`

HTTPレスポンスを直接tarfileに渡すことで、27GBを一切ディスクに書かずにストリーム処理できる。メモリ使用量は常に~100MB以下。

### 再接続設計

ネットワーク切断時の自動復旧フロー：

```
tarfile.ReadError（切断） → キューのworkerは継続稼働
                          → 60〜180秒待機
                          → DONE_FILEをスキップセットに追加
                          → ダンプを先頭から再ダウンロード
                          → 既処理済みをスキップして続きから再開
```

### /api/contribute/submit-batch（高速化エンドポイント）

インポート中にWorkerの並列性能を最大化するために追加した専用エンドポイント：

```javascript
// 最大25件を1リクエストで処理
if (pathname === "/api/contribute/submit-batch" && request.method === "POST") {
  const valid = body.articles.slice(0, 25);
  
  // R2への並列アップロード
  await Promise.all(valid.map(a => env.HTML_BUCKET.put(a.title, a.html, {...})));
  
  // D1へのバッチINSERT（競合を大幅削減）
  const stmts = valid.map(a => env.DB.prepare("INSERT INTO articles...").bind(a.title));
  await env.DB.batch(stmts);
  
  return json({ ok: true, processed: valid.length });
}
```

---

## 10. 完走記録と統計

### 最終結果（2026-10-10）

| 項目 | 数値 |
|---|---|
| 今回アップロード（v2） | **1,224,216件** |
| 既存アップロード（v1+事前） | 259,133件 |
| **システム総記事数** | **約1,483,349件** |
| 処理ファイル数 | 72ファイル |
| 所要時間 | **16時間21分** |
| 平均速度 | 21件/秒 |
| 最高速度 | 54件/秒 |
| 自動再接続回数 | 4回（上限10回） |
| 失敗件数 | **16件（0.001%）** |

### 速度推移の記録

インポート開始直後はCloudflare WorkersのコールドスタートのためHTTP接続ごとに遅かったが、Workersが自動スケールするにつれ急激に加速した：

```
開始時  :  2件/s（217時間予測）
10分後  : 22件/s（16時間予測）
20分後  : 37件/s（  9時間予測）
30分後  : 50件/s（  6時間予測）※1回目切断
再接続後: 36件/s → 54件/s（最高速）
```

### 比較

| 方法 | 推定所要時間 |
|---|---|
| cronバッチのみ（毎分30件） | 約32日 |
| dump_import v1（切断失敗） | 未完走 |
| **dump_import v2（今回）** | **16.21時間** |
| 理論最速（バッチv3使用時） | 推定5〜8時間 |

---

## 11. 今後の展望

### 短期（〜1ヶ月）

- **差分更新**: 毎月Wikimediaが新しいダンプを公開する。今回のDONE_FILEを活用し、新規記事のみを追加インポート
- **IPFS完全化**: 現在CIDがない記事（selfHeal + replicationHealで自動処理中）
- **dump_import v3（バッチ版）**: `dump_import_batch.py` で次回は5〜8時間での完走を目指す

### 中期（〜6ヶ月）

- **多言語対応**: 英語版（en-wiki）、中国語版（zh-wiki）等の追加
- **P2Pノード拡大**: bootstrapスクリプトを公開し、分散ノードを世界中に展開
- **Nostr DHT本格稼働**: ノード間の記事分担を実際のトラフィックで最適化

### 長期ビジョン

Phoenix Meshの最終形は「**どの単一主体も停止できないWikipedia**」だ。

- Cloudflareが止めても: IPFSゲートウェイ経由でアクセス可能
- 日本政府が遮断しても: Torやフリーネットワーク経由、または海外ノードから
- Wikimediaが閉鎖しても: 既にミラーリング完了、差分更新は他ソースから
- 全ての中央サーバーが消えても: Nostrに登録されたP2Pノード群が生き続ける

---

## 付録: 主要ファイル構成

```
/Users/tohr/wikipedia/
├── src/
│   └── index.js          # Cloudflare Worker本体（~5500行）
├── scripts/
│   ├── dump_import.py    # ダンプインポーター v2（本番使用）
│   └── dump_import_batch.py  # バッチ版 v3（次回用）
├── wrangler.jsonc        # Cloudflare設定
└── PHOENIX_MESH_OVERVIEW.md  # 本ドキュメント

/tmp/
├── existing_titles.txt       # 重複除外リスト（259,133件）
└── phoenix_done_this_run.txt # 今回完了リスト（1,224,216件）
```

## 付録: 重要なAPI仕様

### POST /api/contribute/submit
```json
{"title": "東京", "html": "<html>..."}
→ {"ok": true, "title": "東京", "stored": true}
```

### POST /api/contribute/submit-batch
```json
{"articles": [{"title": "東京", "html": "..."}, ...]}  // 最大25件
→ {"ok": true, "processed": 25}
```

### GET /api/contribute/next?node_id=abc123
```json
{"title": "次に保全すべき記事タイトル"}
// node_idがあればConsistent Hashingで担当範囲をフィルタ
```

### POST /api/contribute/proof
```json
{"titles": ["東京", "大阪", ...]}
→ {"ok": true, "updated": 2}
// por_countをインクリメント → Nakamoto係数が上昇
```

---

*最終更新: 2026-10-10 — 日本語版Wikipedia全記事ミラーリング完走の日*
