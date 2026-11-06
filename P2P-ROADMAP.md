# Feuille de route : fonctions de participation P2P

Plan de mise en œuvre d'un mode P2P permettant aux visiteurs eux-mêmes de contribuer à l'épinglage.

---

## Niveau 1 — Inciter à participer par l'interface

Ajouter à la page un bouton permettant au visiteur d'épingler en un clic.

**Contenu de la mise en œuvre :**
- En bas de chaque page d'article, afficher le CID avec un bouton de copie (déjà affiché en petit texte actuellement)
- Bouton « Épingler cette page sur IPFS » → appelle l'API pinByHash de Pinata
- Pour les utilisateurs d'un nœud IPFS, copier en un clic la commande `ipfs pin add <CID>`

**Difficulté :** faible  
**Nécessaire :** il suffit de mettre à jour la partie du Worker qui injecte le HTML

---

## Niveau 2 — Mise en cache automatique par un Service Worker

Le navigateur met automatiquement en cache les pages consultées et les redistribue aux visiteurs suivants.

**Contenu de la mise en œuvre :**
- Installer automatiquement le Service Worker `sw.js` à la visite de la page
- Enregistrer dans le `Cache API` le CID et le HTML des articles visités
- Lors de l'accès suivant, répondre depuis le cache du navigateur sans passer par le serveur
- Gérer la liste des CID visités avec `IndexedDB`

**Difficulté :** moyenne  
**Effet :** allègement de la charge du serveur + le visiteur joue le rôle de nœud de cache

---

## Niveau 3 — Transformer le navigateur en véritable nœud IPFS avec Helia (vrai P2P)

Le navigateur du visiteur devient lui-même un nœud IPFS et se connecte directement aux autres navigateurs par WebRTC.

**Contenu de la mise en œuvre :**
- Intégrer `@helia/verified-fetch` + le transport WebRTC dans le bundle
- Démarrer un nœud Helia dans le Service Worker
- Récupérer les articles en P2P via la DHT d'IPFS (sans passerelle)
- Le simple fait de consulter fait automatiquement du visiteur un « seeder » : ceux qui ont vu le même article se le distribuent entre eux
- La vérification des CID (comparaison des hachages) automatise la détection des altérations

**Difficulté :** élevée  
**Nécessaire :** un bundle Helia (`@helia/unixfs`, `@libp2p/webrtc`, etc.) et une chaîne de build

**Bibliothèques de référence :**
- https://github.com/ipfs/helia
- `@helia/verified-fetch`
- `@libp2p/webrtc`

---

## Ordre de mise en œuvre

```
Niveau 1 (bouton dans l'interface) → Niveau 2 (Service Worker) → Niveau 3 (Helia P2P)
```

Les niveaux 1 et 2 se réalisent entièrement par l'injection de HTML dans le Cloudflare Worker.  
Le niveau 3 exige une chaîne de build distincte.
