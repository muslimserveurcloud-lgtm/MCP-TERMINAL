# MUSLIM MCP TERMINAL

```bash
git clone <repository>
cd mcp-terminal
npm install
npm run build
npm start
```

Terminal CLI universel qui fonctionne comme **client MCP** (Model Context Protocol) : il se connecte à des serveurs MCP locaux (stdio) ou distants (Streamable HTTP, SSE legacy), puis liste/décrit/appelle leurs *tools*, lit leurs *resources* et récupère leurs *prompts*.

> **Prérequis** : Node.js **20 ou plus** (le SDK MCP v2 l'exige ; Node 18 n'est pas supporté). Compatible Node 20 / 22 / 24.
> **Statut du SDK** : au moment de l'écriture, la documentation officielle du SDK v2 (`@modelcontextprotocol/client`, `@modelcontextprotocol/server`) est étiquetée *beta* (`2.0.0-beta.x`). `package.json` demande `^2.0.0-beta.1`, ce qui accepte aussi les versions stables 2.x. Voir *Dépannage* si npm ne résout pas la version.

## 1. Présentation

- Client MCP universel basé sur le SDK officiel v2 (aucun JSON-RPC réimplémenté : transport, handshake, négociation de protocole, pagination et erreurs sont gérés par le SDK).
- Transports : **stdio** (processus enfant), **Streamable HTTP** (prioritaire), **HTTP+SSE** (repli legacy automatique si le serveur répond 400/404/405 au Streamable HTTP, ou forcé avec `--sse`).
- REPL interactif (`mcp>`) avec historique, flèches, autocomplétion, Ctrl+C / Ctrl+D, couleurs.
- Mode commande unique (scripts, Termux, GitHub Actions) et **mode JSON** (`--json`).
- Découverte de serveurs via l'API officielle du registre MCP.
- Zéro dépendance native, zéro Docker/Python/root : Node.js seulement.

## 2. Architecture

```
src/
  cli.ts            point d'entrée (options globales, commande unique ou REPL)
  repl.ts           REPL readline : historique, autocomplétion, Ctrl+C/Ctrl+D
  commands.ts       dispatcher des commandes (/servers, /tools, ...)
  mcpClient.ts      McpClientManager : connexions, tools, resources, prompts, timeouts
  serverManager.ts  gestion des serveurs enregistrés + session active
  discovery.ts      client du registre officiel MCP
  config.ts         servers.json, ${VAR}, .env, tokenisation, validation d'URL
  format.ts         sortie lisible / JSON, couleurs, rendu des schémas
  errors.ts         McpTerminalError + traduction des erreurs du SDK
  logger.ts         logs sur stderr avec masquage systématique des secrets
  types.ts          schémas Zod (configuration) et types
  providers/        raccourcis github.ts, elevenlabs.ts, firebase.ts (+ common.ts)
examples/           demo-server.ts (stdio) et demo-factory.ts
tests/              config, serverManager, mcpClient (node:test, sans Internet)
```

## 3. Installation

```bash
npm install
npm run build      # compile TypeScript strict vers dist/
npm start          # lance le REPL
npm start -- --json /servers list   # commande unique (note le "--" de npm)
```

Pour disposer de la commande `mcp-terminal` : `npm link` (puis `mcp-terminal /servers list`).

## 4. Configuration

Fichier : `~/.mcp-terminal/servers.json` (dossier `0700`, fichier `0600`, écriture atomique). Surcharge du dossier : `MCP_TERMINAL_HOME`.

```json
{
  "defaultServer": "filesystem",
  "servers": {
    "filesystem": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/storage/emulated/0/Download"]
    },
    "github": {
      "name": "github",
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

**Secrets** : jamais en clair. Seules les références `${VARIABLE}` sont enregistrées ; les valeurs sont lues dans l'environnement ou dans `./.env` / `~/.mcp-terminal/.env` (voir `.env.example`). Un secret en clair dans `--env`, `--header`, une URL ou un argument (`--token xxx`) est **refusé** (`SECRET_LITERAL`), y compris dans un fichier édité à la main. Les valeurs résolues sont masquées dans les logs, erreurs, sorties et l'historique.

Variables supportées : `GITHUB_TOKEN`, `ELEVENLABS_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `MCP_AUTH_TOKEN`, et toute autre via `--env`/`--header`.
Réglages : `MCP_TERMINAL_TIMEOUT_MS` (défaut 60000), `MCP_TERMINAL_LOG_LEVEL` (`silent|error|warn|info|debug`), `MCP_TERMINAL_LOG_FILE`.

Options globales (n'importe où dans la ligne) : `--json`, `--quiet/-q`, `--yes/-y`, `--server/-s <nom>`, `--timeout <ms>`, `--no-color`, `--help`, `--version`.

En **commande unique**, chaque exécution se connecte puis se déconnecte : le serveur utilisé est `--server`, sinon le serveur par défaut (défini par `/servers connect <nom>`), sinon l'unique serveur configuré.

## 5. Serveur stdio

```bash
mcp-terminal /servers add filesystem \
  --stdio "npx -y @modelcontextprotocol/server-filesystem /storage/emulated/0/Download"
mcp-terminal /servers connect filesystem
mcp-terminal /tools list
```

La commande est découpée comme un shell (guillemets), mais **aucun shell n'est lancé** : `; | & < > \`` et `$(` hors guillemets sont refusés. Options : `--env NOM` (équivaut à `NOM=${NOM}`), `--env NOM='${AUTRE}'`, `--cwd <dossier>`, `--force` (remplacer).

Serveur de démonstration (hello, calculate, une resource, un prompt) :

```bash
npm run build
mcp-terminal /servers add demo --stdio "node dist/examples/demo-server.js"
mcp-terminal /servers test demo
mcp-terminal /tools call hello '{"name":"Awa"}' --server demo
```

`npm run demo:server` lance le serveur seul pour l'inspecter (par exemple avec `npx @modelcontextprotocol/inspector node dist/examples/demo-server.js`) ; un serveur stdio est normalement **lancé par le client**, pas depuis un second terminal.

## 6. Serveur Streamable HTTP

```bash
mcp-terminal /servers add github --http "https://api.githubcopilot.com/mcp/" \
  --header 'Authorization=Bearer ${GITHUB_TOKEN}'
```

⚠ Utilisez des **guillemets simples** pour que votre shell ne remplace pas `${GITHUB_TOKEN}`. Un `http://` non local déclenche un avertissement.

## 7. Serveur SSE legacy

```bash
mcp-terminal /servers add ancien --sse "https://exemple.org/sse" --header 'Authorization=Bearer ${MCP_AUTH_TOKEN}'
```

Avec `--http`, le repli SSE est automatique si le serveur ne supporte pas Streamable HTTP.

## 8. GitHub

Raccourcis (utilisent **uniquement** les tools réellement exposés par le serveur connecté ; arguments construits d'après le schéma du tool) :

```bash
mcp-terminal /github list-repos --owner octocat
mcp-terminal /github get-issue octocat/hello-world 42
mcp-terminal /github create-pr octocat/hello-world "Titre" --head ma-branche --base main --body "Description"
```

Si aucun tool ne correspond, l'erreur `TOOL_NOT_FOUND` liste les tools disponibles ; si un paramètre requis n'est pas couvert, complétez avec `--input-json '{"param":"valeur"}'` ou utilisez `/tools call`.

## 9. ElevenLabs

```bash
mcp-terminal /elevenlabs voices
mcp-terminal /elevenlabs tts "Bonjour tout le monde" --voice "Nom de voix"
```

Le serveur MCP ElevenLabs officiel est distribué en Python (`uvx`), ce qui n'est pas disponible partout (Termux sans Python) : branchez-le depuis une machine qui l'exécute, ou utilisez tout serveur MCP compatible accessible en HTTP. Clé : `ELEVENLABS_API_KEY` (via `--env ELEVENLABS_API_KEY`).

## 10. Firebase

```bash
mcp-terminal /firebase list-collections
mcp-terminal /firebase get utilisateurs alice
mcp-terminal /firebase add utilisateurs '{"nom":"Alice","age":30}'
```

Les noms de tools et paramètres varient selon le serveur Firebase MCP : le terminal s'adapte au schéma exposé, sinon utilisez `/tools describe` puis `/tools call`. Passez vos identifiants par variable d'environnement (`--env FIREBASE_SERVICE_ACCOUNT`).

## 11. Découverte du registre

```bash
mcp-terminal /discover                 # tout
mcp-terminal /discover github          # catégories : github firebase elevenlabs database ai media
mcp-terminal /discover "postgres" --limit 10
mcp-terminal --json /discover ai
```

Interroge `https://registry.modelcontextprotocol.io/v0.1/servers` (aucune liste codée en dur) et affiche nom, description, version, publisher, transport, installation, repository, documentation. Le registre est en préversion : le format peut évoluer.

## 12. Tools

```bash
/tools list
/tools describe create_issue          # description, schéma, types, requis, contraintes
/tools call create_issue '{"owner":"o","repo":"r","title":"Bug"}'
/tools call create_issue --input-json '{"owner":"o","repo":"r","title":"Bug"}'
```

Avant l'appel : vérification des paramètres requis ; **confirmation** pour les tools destructeurs (`destructiveHint` ou nom du type `delete`, `remove`, `drop`…), contournable avec `--yes`. Un résultat `isError` donne le code de sortie 1.

## 13. Resources

```bash
/resources list
/resources read demo://about
```

## 14. Prompts

```bash
/prompts list
/prompts get resume sujet=MCP
/prompts get resume --args '{"sujet":"MCP"}'
```

## 15. Mode JSON

```bash
mcp-terminal --json /servers list      # {"servers": [...]}
mcp-terminal --json /servers connect inconnu
# {"error": true, "code": "SERVER_NOT_FOUND", "message": "...", "hint": "..."}
```

Les données et erreurs JSON vont sur stdout, les avertissements sur stderr. Codes d'erreur : `SERVER_NOT_FOUND`, `SERVER_EXISTS`, `NOT_CONNECTED`, `INVALID_CONFIG`, `INVALID_ARGUMENT`, `INVALID_URL`, `SECRET_LITERAL`, `MISSING_ENV`, `CONNECTION_FAILED`, `TIMEOUT`, `TOOL_NOT_FOUND`, `MCP_ERROR`, `DISCOVERY_FAILED`, `CONFIRMATION_REQUIRED`, `CANCELLED`, `UNKNOWN_COMMAND`, `INTERNAL`. En mode JSON, les confirmations exigent `--yes`.

## 16. Termux (Android)

```bash
pkg update && pkg install nodejs-lts git
termux-setup-storage                    # accès à /storage/emulated/0/Download
git clone <repository> && cd mcp-terminal
npm install && npm run build && npm start
```

Les chemins Android (`/storage/emulated/0/Download`) sont acceptés. Les serveurs stdio reçoivent un environnement minimal ; les variables Termux utiles (`PREFIX`, `TMPDIR`, `LD_PRELOAD`…) sont transmises. Si un serveur a besoin d'une autre variable : `--env NOM`.

## 17. GitHub Actions

```yaml
name: mcp
on: [workflow_dispatch]
jobs:
  list-tools:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install && npm run build
      - run: |
          node dist/src/cli.js /servers add github --http "https://api.githubcopilot.com/mcp/" \
            --header 'Authorization=Bearer ${GITHUB_TOKEN}'
          node dist/src/cli.js --json /tools list --server github
        env:
          GITHUB_TOKEN: ${{ secrets.MCP_GITHUB_TOKEN }}
```

## 18. Sécurité

- Validation Zod de la configuration, des URL (http/https uniquement, identifiants et secrets dans l'URL refusés) et des arguments JSON (objet, 1 Mo max).
- Pas de shell : les serveurs stdio sont lancés directement (`command` + `args`).
- Timeouts sur connexion et requêtes ; fermeture propre des processus enfants (fin de commande, `/exit`, Ctrl+D, SIGINT/SIGTERM).
- Secrets : références `${VAR}` uniquement, fichier `0600`, masquage partout (logs, erreurs, sorties, historique).
- Confirmation avant opérations potentiellement destructrices.
- Le terminal est un client générique : il ne contourne jamais les permissions des serveurs et n'exécute que ce que vous lui demandez.
- Les serveurs MCP stdio sont des programmes exécutés avec vos droits : n'ajoutez que des serveurs de confiance.

## 19. Tests

```bash
npm test      # compile puis lance node --test (aucun accès Internet)
npm run lint  # vérification de types (tsc --noEmit)
```

Couvre : configuration, ajout/suppression, connexion stdio (serveur de démo), connexion Streamable HTTP en mémoire (`createMcpHandler` + `fetch` injecté), listing et appel de tools, resources, prompts, erreurs, secrets, sortie JSON.

## 20. Dépannage

| Symptôme | Piste |
|---|---|
| `npm install` ne trouve pas `@modelcontextprotocol/client@^2.0.0-beta.1` | `npm view @modelcontextprotocol/client versions`, puis ajustez la plage dans `package.json` ; vérifiez `--registry=https://registry.npmjs.org/` |
| Erreurs TypeScript sur le SDK au `npm run build` | le SDK v2 évolue : comparez avec https://ts.sdk.modelcontextprotocol.io/v2/ (imports `@modelcontextprotocol/client`, `.../client/stdio`) |
| `CONNECTION_FAILED` en stdio | lancez la commande seule dans le terminal ; vérifiez `PATH`/`npx` ; ajoutez `--env` si une variable est requise |
| `MISSING_ENV` | exportez la variable ou mettez-la dans `.env` / `~/.mcp-terminal/.env` |
| `SECRET_LITERAL` | remplacez la valeur par `${NOM}` entre guillemets simples |
| `TOOL_NOT_FOUND` sur un raccourci | lisez la liste affichée, puis `/tools describe` et `/tools call` |
| `TIMEOUT` | augmentez `--timeout <ms>` ou `MCP_TERMINAL_TIMEOUT_MS` |
| Serveur HTTP ancien qui échoue à la négociation | enregistrez-le avec `"protocolNegotiation": "default"` dans `servers.json` |
| Debug | `MCP_TERMINAL_LOG_LEVEL=debug MCP_TERMINAL_LOG_FILE=~/mcp.log npm start` |
