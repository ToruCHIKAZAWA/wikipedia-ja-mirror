# Phoenix Mesh — Système de préservation permanente de Wikipédia : présentation complète

> « Wikipédia est mort. Mais le savoir ne meurt pas. »

---

## Table des matières

1. [La philosophie du projet](#1-la-philosophie-du-projet)
2. [Architecture globale du système](#2-architecture-globale-du-système)
3. [Cloudflare Workers — le système nerveux central](#3-cloudflare-workers--le-système-nerveux-central)
4. [Stockage en trois couches](#4-stockage-en-trois-couches)
5. [Protocole d'auto-réplication de Von Neumann](#5-protocole-dauto-réplication-de-von-neumann)
6. [Nostr DHT — découverte distribuée des nœuds](#6-nostr-dht--découverte-distribuée-des-nœuds)
7. [Cascade du graphe de connaissances](#7-cascade-du-graphe-de-connaissances)
8. [Tableau de bord du coefficient de Nakamoto](#8-tableau-de-bord-du-coefficient-de-nakamoto)
9. [Import massif du dump HTML Enterprise](#9-import-massif-du-dump-html-enterprise)
10. [Journal d'exécution et statistiques](#10-journal-dexécution-et-statistiques)
11. [Perspectives](#11-perspectives)

---

## 1. La philosophie du projet

### Pourquoi l'avoir créé

Wikipédia dépend aujourd'hui d'un parc de serveurs géré par une seule organisation à but non lucratif (la Wikimedia Foundation). Cela comporte les risques suivants :

- **Censure et blocage par les gouvernements** (cas avérés en Chine, en Russie, en Turquie, etc.)
- **Fermeture pour raisons financières** (dépendance totale aux dons)
- **Changement de ligne éditoriale** (réécriture ou suppression de contenus)
- **Point de défaillance unique** (DDoS, panne de serveur)

Sous la philosophie « **même si Wikipédia meurt, le savoir ne meurt pas** », Phoenix Mesh est un projet qui transplante l'ensemble des articles de Wikipédia en japonais dans un réseau distribué où la censure, la suppression et la disparition sont impossibles.

### Le sens du nom de domaine

`wikipedia-is-dead.com` — ce n'est pas une provocation, mais une déclaration. C'est un énoncé de principe : « la forme centralisée de Wikipédia est révolue. Le savoir ne dépend plus d'un serveur particulier. »

### La métaphore du Phénix

Comme le phénix qui renaît de ses cendres, quel que soit le serveur qui tombe, quel que soit le gouvernement qui bloque, l'ensemble du réseau se répare et se réplique de lui-même pour continuer à protéger le savoir. C'est l'origine du nom Phoenix Mesh.

---

## 2. Architecture globale du système

```
[Utilisateur]
     │
     ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Workers (Edge Computing)         │
│  wikipedia-is-dead.com                       │
│  ├── Diffusion des articles (R2 d'abord,     │
│  │   repli sur D1)                           │
│  ├── Lots cron (chaque minute : nouveaux     │
│  │   articles + réparation IPFS)             │
│  ├── Groupe d'API (submit/submit-batch/      │
│  │   proof/nodes)                            │
│  └── Surcouche P2P (badge du coefficient     │
│      de Nakamoto)                            │
└──────────────┬──────────────────────────────┘
               │
     ┌─────────┴──────────┐
     ▼                    ▼
┌─────────┐        ┌─────────────┐
│  R2     │        │    D1       │
│ (HTML   │        │  (SQLite)   │
│  brut)  │        │ (métadonnées)│
└─────────┘        └─────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  IPFS / Pinata                              │
│  (conservation permanente adressée par le   │
│  contenu)                                   │
│  Basé sur les CID : même si l'URL d'un      │
│  article change, son contenu reste inchangé │
└─────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  Réseau de relais Nostr                      │
│  (registre des nœuds, messagerie P2P)        │
└─────────────────────────────────────────────┘
```

---

## 3. Cloudflare Workers — le système nerveux central

### Pourquoi Cloudflare Workers

- **Edge computing** : fonctionne dans plus de 300 PoP (points de présence) dans le monde. Aucun point de défaillance géographique unique
- **Sans serveur** : aucune machine physique à gérer, mise à l'échelle automatique
- **Offre Paid** : base de données D1 à 5 milliards de lignes par mois (quasiment illimité), requêtes Workers illimitées

### Principaux points d'accès

| Point d'accès | Méthode | Fonction |
|---|---|---|
| `/wiki/{title}` | GET | Diffusion d'un article (R2 → repli sur D1) |
| `/api/contribute/submit` | POST | Envoi d'un article |
| `/api/contribute/submit-batch` | POST | Envoi groupé de 25 articles au maximum |
| `/api/contribute/next` | GET | Renvoie le prochain article à préserver |
| `/api/contribute/proof` | POST | Enregistrement d'un Proof-of-Read |
| `/api/nodes/announce` | POST | Enregistrement d'un nœud P2P |
| `/api/nodes` | GET | Liste des nœuds actifs |
| `/bootstrap` | GET | Script de démarrage d'un nœud contributeur (auto-descriptif) |

### Planificateur cron (exécuté chaque minute)

```
scheduled handler (chaque minute)
├── processBatch()    — récupère de nouveaux articles via l'API Wikipédia → enregistre dans R2/D1
├── selfHeal()        — détecte les articles sans CID → épinglage IPFS
└── replicationHeal() — détecte les articles avec por_count=0 → renforce l'épinglage
```

### Flux de diffusion d'un article (conception « R2 d'abord »)

```
Requête /wiki/東京
    │
    ▼
L'objet existe-t-il dans R2 ?
    ├── OUI → renvoyé aussitôt (x-served-by: r2) ← aucune requête D1
    └── NON → récupère le CID depuis D1 → renvoyé via une passerelle IPFS
```

Cette conception a résolu le problème du quota de 5 millions de lignes par jour de D1. Plus de 99 % des requêtes se terminent avec R2 seul.

---

## 4. Stockage en trois couches

### Niveau 1A : Cloudflare R2 (stockage principal)

- **Nom du bucket** : `wikipedia-ja-html`
- **Capacité** : illimitée (facturation à l'usage)
- **Volume actuel** : environ 1 483 349 articles en HTML
- **Caractéristiques** : diffusion à la périphérie, faible latence, redondance mondiale

### Niveau 1B : Cloudflare D1 (métadonnées)

- **Table** : `articles (title, cid, por_count, uploaded_at)`
- **Rôle** : correspondance des CID, comptage des lecteurs, statistiques
- **Exemples de requêtes** :
  ```sql
  SELECT COUNT(*) FROM articles WHERE cid != ''  -- nombre d'articles déjà sur IPFS
  SELECT title FROM articles ORDER BY RANDOM() LIMIT 30  -- lot aléatoire
  ```

### Niveau 1C : IPFS / Pinata (conservation permanente)

- **CIDv1** : adresse de contenu (tant que le contenu ne change pas, l'URL non plus)
- **Services d'épinglage** : Pinata (principal) + NFT.Storage / Filebase / Lighthouse (secondaires)
- **Signification** : même si Cloudflare disparaît, les articles subsistent sur le réseau IPFS

### Calcul du coefficient de Nakamoto N

```
N = por_count (nombre de lectures réelles via IPFS) + 2 (R2 + Pinata, acquis)
```

N ≥ 3 : STABLE (préservation stable)
N ≥ 7 : ROBUST (robuste)
N ≥ 10 : IMMORTAL (immortel)

---

## 5. Protocole d'auto-réplication de Von Neumann

### Contexte intellectuel

Dans les années 1940, John von Neumann a construit la théorie des « machines capables de se reproduire » (Universal Constructor). L'idée clé :

> « Une machine qui se réplique doit posséder une description complète d'elle-même (un génome). »

Phoenix Mesh applique ce principe à un réseau numérique.

### Mise en œuvre du génome

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
      // Version numérique des règles de l'automate cellulaire de Von Neumann
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

### Le point d'accès /bootstrap (régénération auto-descriptive)

Un accès à ce point d'accès renvoie un **script Python capable de régénérer l'ensemble du réseau**.

```bash
curl -sL https://wikipedia-is-dead.com/bootstrap | python3
```

Contenu du script :
1. Enregistre le nœud dans la DHT Nostr et obtient sa plage de hachage
2. N'explore que les articles non préservés de sa plage (aucune bande passante gaspillée)
3. Même si le serveur central tombe, découvre d'autres nœuds à partir de la liste de pairs et continue
4. Dépendances : uniquement la bibliothèque standard de Python

Même principe que le constructeur universel de Von Neumann : **ce point d'accès est lui-même le « gène » du réseau**, et permet de reconstruire l'ensemble de n'importe où.

---

## 6. Nostr DHT — découverte distribuée des nœuds

### Pourquoi Nostr

S'il existait un serveur central de registre des nœuds, il suffirait de l'attaquer pour paralyser tout le réseau. Avec le protocole Nostr, les informations sur les nœuds sont stockées de manière distribuée sur le réseau de relais.

### Consistent Hashing (hachage cohérent)

```javascript
function titleHashSimple(title) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) & 0xff;
  return h; // 0-255
}
```

Chaque nœud se voit attribuer une plage de hachage de 0 à 255 et **ne préserve que les articles de sa propre plage**. De ce fait :

- les articles sont automatiquement répartis entre les nœuds
- si un nœud tombe, les autres nœuds prennent le relais
- la charge se répartit automatiquement à mesure que le réseau s'étend

### Flux d'enregistrement d'un nœud

```
POST /api/nodes/announce
  {"node_id": "abc123", "url": "https://my-node.example.com"}
    │
    ▼
1. Attribue une plage de hachage selon le nombre de nœuds existants
2. Publie un événement Nostr kind:30078
3. Renvoie la liste de pairs (les autres nœuds actifs)
4. Les nœuds dont le heartbeat échoue sont supprimés automatiquement
```

---

## 7. Cascade du graphe de connaissances

### Concept

Les articles de Wikipédia sont reliés entre eux par des hyperliens. Si l'on préserve l'article « Tokyo », les articles « Shibuya », « Shinjuku » et « Palais impérial » qui y sont liés deviennent automatiquement les cibles de préservation suivantes. C'est la **cascade du graphe de connaissances**.

### Mise en œuvre de la file BFS

```javascript
// File BFS enregistrée dans R2 sous le nom __graph-queue.json
async function pushToGraphQueue(env, titles) {
  const queue = await popFromGraphQueue(env, 0); // récupère la file actuelle
  const merged = [...new Set([...queue, ...titles])].slice(0, 5000);
  await env.HTML_BUCKET.put('__graph-queue.json', JSON.stringify(merged));
}

async function popFromGraphQueue(env, n) {
  const obj = await env.HTML_BUCKET.get('__graph-queue.json');
  const queue = obj ? JSON.parse(await obj.text()) : [];
  return n === 0 ? queue : queue.splice(0, n);
}
```

### Fonctionnement de processBatch()

```
processBatch() (appelé chaque minute par le cron)
    │
    ├── 1. Y a-t-il des articles dans la file du graphe ?
    │       OUI → ces titres deviennent les cibles d'exploration
    │       NON → sélection aléatoire via l'API allpages de Wikipédia
    │
    ├── 2. Récupération du HTML de chaque article (en parallèle)
    │
    ├── 3. Enregistrement dans R2 + INSERT dans D1
    │
    └── 4. Extraction des liens de l'article → ajout à la file du graphe (await)
              └── extractWikiLinks()
                    Prise en charge des URL absolues : href="https://ja.wikipedia.org/wiki/TITLE"
```

---

## 8. Tableau de bord du coefficient de Nakamoto

### Concept

Le coefficient de Nakamoto est un indicateur issu du domaine de la blockchain : il exprime « le nombre minimal de nœuds nécessaires pour dominer le réseau ». Plus la valeur est élevée, plus la décentralisation et la robustesse sont grandes.

Phoenix Mesh le détourne pour mesurer la diffusion sur IPFS.

### Classification de l'état de chaque article

```javascript
function getArticleState(cid, porCount) {
  if (!cid)          return 'UNPROCESSED'; // pas encore sur IPFS
  if (porCount <= 0) return 'ENDANGERED';  // sur IPFS mais sans aucun lecteur
  if (porCount <= 2) return 'LOW';         // peu de lecteurs
  if (porCount <= 6) return 'STABLE';      // stable
  if (porCount <= 9) return 'ROBUST';      // robuste
  return 'IMMORTAL';                       // immortel
}
```

### Affichage du badge sur la page d'un article

En bas à droite de chaque page d'article, une barre à 7 segments :

```
N = por_count + 2 (R2 + Pinata, acquis)

[██████░] N=6 STABLE   ← vert
[███░░░░] N=3 LOW      ← jaune
[█░░░░░░] N=1 ENDANGERED ← rouge
```

### Proof-of-Read

Quand un lecteur lit un article, `por_count` est automatiquement incrémenté. Cela constitue une preuve que « cet article est réellement lu = il a de la valeur = sa priorité de préservation est élevée ».

---

## 9. Import massif du dump HTML Enterprise

### Contexte et motivation

Avec le lot cron ordinaire (30 articles par minute), la récupération de 1,4 million d'articles aurait pris **environ 32 jours**.

Avec le **dump HTML Enterprise** fourni par Wikimedia (HTML déjà rendu par Parsoid), on peut récupérer tous les articles d'un seul coup, sans appeler l'API.

### Spécification du dump

```
URL : https://dumps.wikimedia.org/other/enterprise_html/runs/20250320/
      jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz

Format : NDJSON dans une archive tar.gz (un article par ligne)
Structure : {"name": "東京", "article_body": {"html": "<html>..."}}
Composition des fichiers : jawiki_namespace_0_0.ndjson à jawiki_namespace_0_71.ndjson (72 fichiers)
Chaque fichier : environ 2 Go (après décompression)
Taille totale décompressée : environ 147 Go
Taille compressée : 27,4 Go
```

### Conception de dump_import.py v2

```python
DUMP_URL   = "https://dumps.wikimedia.org/.../jawiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz"
SUBMIT_URL = "https://wikipedia-is-dead.com/api/contribute/submit"
EXISTING   = "/tmp/existing_titles.txt"       # liste d'exclusion des doublons
DONE_FILE  = "/tmp/phoenix_done_this_run.txt" # éléments déjà envoyés lors de cette exécution (pour la reconnexion)
WORKERS    = 50                               # nombre de threads parallèles
MAX_RECONN = 10                               # nombre maximal de reconnexions
```

**L'astuce centrale** : `tarfile.open(fileobj=resp, mode="r|gz")`

En passant directement la réponse HTTP à tarfile, on traite les 27 Go en flux sans rien écrire sur le disque. L'utilisation de la mémoire reste toujours inférieure à environ 100 Mo.

### Conception de la reconnexion

Flux de récupération automatique en cas de coupure réseau :

```
tarfile.ReadError (coupure) → les workers de la file continuent de tourner
                            → attente de 60 à 180 secondes
                            → ajout de DONE_FILE à l'ensemble des éléments à ignorer
                            → nouveau téléchargement du dump depuis le début
                            → ignore ce qui est déjà traité et reprend à la suite
```

### /api/contribute/submit-batch (point d'accès d'accélération)

Point d'accès dédié, ajouté pour maximiser les performances parallèles du Worker pendant l'import :

```javascript
// Traite jusqu'à 25 éléments en une seule requête
if (pathname === "/api/contribute/submit-batch" && request.method === "POST") {
  const valid = body.articles.slice(0, 25);
  
  // Envoi parallèle vers R2
  await Promise.all(valid.map(a => env.HTML_BUCKET.put(a.title, a.html, {...})));
  
  // INSERT par lots dans D1 (réduit fortement les conflits)
  const stmts = valid.map(a => env.DB.prepare("INSERT INTO articles...").bind(a.title));
  await env.DB.batch(stmts);
  
  return json({ ok: true, processed: valid.length });
}
```

---

## 10. Journal d'exécution et statistiques

### Résultat final (2026-10-10)

| Élément | Valeur |
|---|---|
| Envoyés cette fois (v2) | **1 224 216** |
| Envoyés auparavant (v1 + préalable) | 259 133 |
| **Nombre total d'articles du système** | **environ 1 483 349** |
| Fichiers traités | 72 fichiers |
| Durée | **16 h 21 min** |
| Débit moyen | 21 articles/s |
| Débit maximal | 54 articles/s |
| Reconnexions automatiques | 4 (limite de 10) |
| Échecs | **16 (0,001 %)** |

### Évolution du débit

Juste après le début de l'import, chaque connexion HTTP était lente à cause du démarrage à froid de Cloudflare Workers, puis le débit a fortement augmenté à mesure que les Workers se mettaient à l'échelle automatiquement :

```
Au début       :  2 art./s (217 heures prévues)
Après 10 min   : 22 art./s (16 heures prévues)
Après 20 min   : 37 art./s (9 heures prévues)
Après 30 min   : 50 art./s (6 heures prévues) ※ 1re coupure
Après reconnexion : 36 art./s → 54 art./s (maximum)
```

### Comparaison

| Méthode | Durée estimée |
|---|---|
| Lot cron seul (30 articles par minute) | environ 32 jours |
| dump_import v1 (échec sur coupure) | non terminé |
| **dump_import v2 (cette fois)** | **16,21 heures** |
| Optimum théorique (avec le lot v3) | estimé entre 5 et 8 heures |

---

## 11. Perspectives

### Court terme (jusqu'à 1 mois)

- **Mise à jour différentielle** : Wikimedia publie chaque mois un nouveau dump. En s'appuyant sur le DONE_FILE de cette fois, n'importer que les nouveaux articles
- **IPFS complet** : articles actuellement sans CID (traitement automatique en cours par selfHeal + replicationHeal)
- **dump_import v3 (version par lots)** : viser, avec `dump_import_batch.py`, une exécution complète en 5 à 8 heures la prochaine fois

### Moyen terme (jusqu'à 6 mois)

- **Prise en charge multilingue** : ajout de la version anglaise (en-wiki), chinoise (zh-wiki), etc.
- **Extension des nœuds P2P** : publier le script bootstrap et déployer des nœuds distribués dans le monde entier
- **Mise en service complète de la DHT Nostr** : optimiser la répartition des articles entre nœuds avec le trafic réel

### Vision à long terme

La forme finale de Phoenix Mesh est « **un Wikipédia qu'aucune entité unique ne peut arrêter** ».

- Même si Cloudflare s'arrête : accessible via les passerelles IPFS
- Même si le gouvernement japonais bloque : via Tor ou des réseaux libres, ou depuis des nœuds à l'étranger
- Même si Wikimedia ferme : le miroir est déjà terminé, les mises à jour différentielles viendront d'autres sources
- Même si tous les serveurs centraux disparaissent : les nœuds P2P enregistrés sur Nostr continuent de vivre

---

## Annexe : organisation des fichiers principaux

```
/Users/tohr/wikipedia/
├── src/
│   └── index.js          # Corps du Cloudflare Worker (~5500 lignes)
├── scripts/
│   ├── dump_import.py    # Importeur de dump v2 (utilisé en production)
│   └── dump_import_batch.py  # Version par lots v3 (pour la prochaine fois)
├── wrangler.jsonc        # Configuration Cloudflare
└── PHOENIX_MESH_OVERVIEW.md  # Le présent document

/tmp/
├── existing_titles.txt       # Liste d'exclusion des doublons (259 133 éléments)
└── phoenix_done_this_run.txt # Liste des éléments terminés cette fois (1 224 216 éléments)
```

## Annexe : spécifications importantes des API

### POST /api/contribute/submit
```json
{"title": "東京", "html": "<html>..."}
→ {"ok": true, "title": "東京", "stored": true}
```

### POST /api/contribute/submit-batch
```json
{"articles": [{"title": "東京", "html": "..."}, ...]}  // 25 éléments au maximum
→ {"ok": true, "processed": 25}
```

### GET /api/contribute/next?node_id=abc123
```json
{"title": "titre du prochain article à préserver"}
// avec node_id, filtre selon la plage de responsabilité par hachage cohérent
```

### POST /api/contribute/proof
```json
{"titles": ["東京", "大阪", ...]}
→ {"ok": true, "updated": 2}
// incrémente por_count → le coefficient de Nakamoto augmente
```

---

*Dernière mise à jour : 2026-10-10 — jour où le miroir de tous les articles de Wikipédia en japonais a été achevé*
