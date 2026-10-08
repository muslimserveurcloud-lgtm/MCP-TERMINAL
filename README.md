# MUSLIM MCP TERMINAL

Client **MCP** (Model Context Protocol) universel :

- **Application Android** (à la racine) — se connecte à des serveurs MCP **distants** (Streamable HTTP), liste/décrit/appelle leurs tools avec un formulaire généré depuis le schéma, lit les resources, récupère les prompts, cherche des serveurs dans le registre officiel MCP.
- **Terminal CLI** (`cli/`) — version Node.js/TypeScript pour Termux et scripts (stdio, Streamable HTTP, SSE, mode `--json`). Voir `cli/README.md`.

## Installer l'application

1. Onglet **Actions** du dépôt → workflow **Build APK Android** (il démarre à chaque push ; sinon *Run workflow*).
2. Quand il est vert, ouvrez **Releases** → `MUSLIM-MCP-TERMINAL.apk` → téléchargez-le sur le téléphone et installez-le (autorisez « sources inconnues » pour votre navigateur).

L'APK est un build *debug* signé avec la clé de debug : suffisant pour un usage personnel.

## Utiliser l'application

1. **Coffre** : créez vos secrets (ex. `GITHUB_TOKEN`). Ils restent dans le stockage privé de l'application, ne s'affichent jamais et sont masqués dans les erreurs.
2. **Serveurs** : ajoutez un serveur (URL Streamable HTTP + en-têtes). Les secrets se référencent ainsi : `Authorization: Bearer ${GITHUB_TOKEN}`. Une valeur sensible en clair est refusée.
3. **Connecter**, puis **Tools / Resources / Prompts**. Les tools destructeurs demandent confirmation.

Exemple GitHub : URL `https://api.githubcopilot.com/mcp/`, en-tête `Authorization: Bearer ${GITHUB_TOKEN}`.

## Limites sur mobile

- Pas de serveurs **stdio** (Android ne permet pas de lancer ces processus) : utilisez le terminal `cli/` sous Termux pour ceux-là.
- Pas de flux SSE « serveur → client » continu ni de serveurs HTTP+SSE legacy : les requêtes passent par la pile HTTP native d'Android (réponses complètes, sans CORS).
- Les secrets sont dans le stockage privé de l'app (sandbox Android), pas dans le Keystore matériel.

## Développement

```bash
npm install
npm run dev        # aperçu web (navigateur)
npm run build      # build web
npm run typecheck
```

Le dossier `android/` est généré par la CI (`npx cap add android`) et n'est pas versionné. Pour le générer en local : `npm run build && npx cap add android && npx cap sync android`.

Technique : Capacitor 8 · React 18 · Vite · `@modelcontextprotocol/client` v2 (beta). Node 22 et JDK 21 requis pour compiler.
