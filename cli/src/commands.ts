import { parseArgs } from 'node:util';
import { discover, renderRegistry } from './discovery.js';
import type { DiscoveryOptions } from './discovery.js';
import { McpTerminalError } from './errors.js';
import { asRecord, formatBytes, renderTable, renderToolDescription, renderToolResult, title } from './format.js';
import type { Output } from './format.js';
import type { GetPromptOutput, ReadResourceOutput, ToolCallResult, ToolInfo } from './mcpClient.js';
import { addDocument, getDocument, listCollections } from './providers/firebase.js';
import { createPullRequest, getIssue, listRepos } from './providers/github.js';
import { listVoices, textToSpeech } from './providers/elevenlabs.js';
import type { ProviderBackend, ProviderRun } from './providers/common.js';
import type { AddServerSpec, ServerKind, ServerManager } from './serverManager.js';
import type { Io } from './types.js';

/* ------------------------------------------------------------------ contexte */

export interface GlobalOptions {
  server: string | undefined;
  timeoutMs: number | undefined;
  yes: boolean;
}

export interface CommandContext {
  servers: ServerManager;
  out: Output;
  io: Io;
  globals: GlobalOptions;
  /** true dans le REPL : la connexion survit entre les commandes. */
  interactive: boolean;
  state: { exitCode: number };
  discoveryOptions?: DiscoveryOptions;
}

export type CommandOutcome = 'continue' | 'exit';

/* --------------------------------------------------------- options globales */

export interface ExtractedGlobals {
  rest: string[];
  json: boolean;
  quiet: boolean;
  yes: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
  server: string | undefined;
  timeoutMs: number | undefined;
}

/** Extrait --json, --quiet, --yes, --server, --timeout, --help, --version où qu'ils soient dans la ligne. */
export function extractGlobals(argv: readonly string[]): ExtractedGlobals {
  const result: ExtractedGlobals = {
    rest: [],
    json: false,
    quiet: false,
    yes: false,
    noColor: false,
    help: false,
    version: false,
    server: undefined,
    timeoutMs: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--json') result.json = true;
    else if (arg === '--quiet' || arg === '-q') result.quiet = true;
    else if (arg === '--yes' || arg === '-y') result.yes = true;
    else if (arg === '--no-color') result.noColor = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--version' || arg === '-v') result.version = true;
    else if (arg === '--server' || arg === '-s') {
      const value = argv[i + 1];
      if (value === undefined) throw new McpTerminalError('INVALID_ARGUMENT', `${arg} attend un nom de serveur.`);
      result.server = value;
      i += 1;
    } else if (arg.startsWith('--server=')) result.server = arg.slice('--server='.length);
    else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg === '--timeout' ? argv[i + 1] : arg.slice('--timeout='.length);
      if (arg === '--timeout') i += 1;
      const parsed = Number.parseInt(raw ?? '', 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3_600_000) {
        throw new McpTerminalError('INVALID_ARGUMENT', '--timeout attend un nombre de millisecondes (1 à 3 600 000).');
      }
      result.timeoutMs = parsed;
    } else result.rest.push(arg);
  }
  return result;
}

export function createIo(options: { yes: boolean; json: boolean; ask?: (question: string) => Promise<string> }): Io {
  return {
    async confirm(question: string): Promise<boolean> {
      if (options.yes) return true;
      if (options.json || options.ask === undefined) {
        throw new McpTerminalError('CONFIRMATION_REQUIRED', `Confirmation requise : ${question}`, 'Relancez avec --yes pour confirmer.');
      }
      const answer = (await options.ask(`${question} [o/N] `)).trim().toLowerCase();
      return ['o', 'oui', 'y', 'yes'].includes(answer);
    },
  };
}

/* ------------------------------------------------------------------- aide */

export const HELP_LINES: ReadonlyArray<readonly [string, string]> = [
  ['/servers list', 'Liste les serveurs configurés'],
  ['/servers add <nom> --stdio "<cmd>" | --http <url> | --sse <url>', 'Ajoute un serveur (--env NOM, --header "Nom=Bearer ${VAR}", --cwd, --force)'],
  ['/servers remove <nom>', 'Supprime un serveur de la configuration'],
  ['/servers connect <nom>', 'Se connecte (et le définit par défaut en mode commande unique)'],
  ['/servers disconnect [nom]', 'Ferme une ou toutes les connexions'],
  ['/servers status', 'État des connexions'],
  ['/servers info [nom]', 'Informations et capabilities du serveur connecté'],
  ['/servers test <nom>', 'Teste la connexion (latence, tools/resources/prompts)'],
  ['/tools list', 'Liste les tools du serveur connecté'],
  ['/tools describe <tool>', "Affiche le schéma d'entrée d'un tool"],
  ['/tools call <tool> <json> | --input-json <json>', 'Appelle un tool (--yes pour confirmer les opérations destructrices)'],
  ['/resources list | read <uri>', 'Resources MCP'],
  ['/prompts list | get <nom> [--args <json> | cle=valeur ...]', 'Prompts MCP'],
  ['/github list-repos | get-issue <repo> <n> | create-pr <repo> <titre>', 'Raccourcis GitHub (tools réellement exposés)'],
  ['/elevenlabs voices | tts <texte>', 'Raccourcis ElevenLabs (tools réellement exposés)'],
  ['/firebase list-collections | get <col> <doc> | add <col> <json>', 'Raccourcis Firebase (tools réellement exposés)'],
  ['/discover [github|firebase|elevenlabs|database|ai|media|<texte>]', 'Recherche dans le registre officiel MCP (--limit n)'],
  ['/json [on|off]  /quiet [on|off]', 'Bascule les modes JSON / silencieux (REPL)'],
  ['/help  /exit', 'Aide / quitter'],
];

export const GLOBAL_HELP = [
  'Options globales : --json  --quiet/-q  --yes/-y  --server/-s <nom>  --timeout <ms>  --no-color  --help/-h  --version/-v',
];

export function renderHelp(): string {
  const width = Math.max(...HELP_LINES.map(([command]) => command.length));
  return [...HELP_LINES.map(([command, description]) => `${command.padEnd(width)}  ${description}`), '', ...GLOBAL_HELP].join('\n');
}

/* ------------------------------------------------------------------ helpers */

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof TypeError && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      throw new McpTerminalError('INVALID_ARGUMENT', error.message, 'Tapez /help pour voir la syntaxe.');
    }
    throw error;
  }
}

function argAt(positionals: readonly string[], index: number, label: string): string {
  const value = positionals[index];
  if (value === undefined || value === '') {
    throw new McpTerminalError('INVALID_ARGUMENT', `Argument manquant : ${label}`, 'Tapez /help pour voir la syntaxe.');
  }
  return value;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  if (raw.length > 1_000_000) throw new McpTerminalError('INVALID_ARGUMENT', `${label} : JSON trop volumineux (> 1 Mo).`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new McpTerminalError(
      'INVALID_ARGUMENT',
      `${label} : JSON invalide (${error instanceof Error ? error.message : 'erreur de syntaxe'}).`,
      `Entourez le JSON de guillemets simples, par exemple '{"cle":"valeur"}'.`,
    );
  }
  const record = asRecord(value);
  if (!record) throw new McpTerminalError('INVALID_ARGUMENT', `${label} : un objet JSON est attendu.`);
  return record;
}

function parseKeyValues(items: readonly string[] | undefined, kind: 'env' | 'header'): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of items ?? []) {
    const separator = kind === 'env' ? item.indexOf('=') : item.search(/[=:]/);
    if (separator === -1) {
      if (kind === 'header') {
        throw new McpTerminalError('INVALID_ARGUMENT', `En-tête invalide : "${item}"`, "Format : --header 'Nom=Bearer ${VARIABLE}'");
      }
      // --env NOM  est un raccourci pour NOM=${NOM} (le secret reste dans l'environnement).
      result[item] = `\${${item}}`;
      continue;
    }
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key === '') throw new McpTerminalError('INVALID_ARGUMENT', `Entrée invalide : "${item}"`);
    result[key] = value;
  }
  return result;
}

function onOff(arg: string | undefined, current: boolean): boolean {
  if (arg === undefined) return !current;
  if (arg === 'on') return true;
  if (arg === 'off') return false;
  throw new McpTerminalError('INVALID_ARGUMENT', 'Utilisez "on" ou "off".');
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/* ---------------------------------------------------------------- dispatcher */

export async function runCommand(ctx: CommandContext, tokens: readonly string[]): Promise<CommandOutcome> {
  const [rawGroup, ...rest] = tokens;
  if (rawGroup === undefined) return 'continue';
  const group = rawGroup.replace(/^\//, '').toLowerCase();
  switch (group) {
    case 'servers':
    case 'server':
      await serversCommand(ctx, rest);
      return 'continue';
    case 'tools':
    case 'tool':
      await toolsCommand(ctx, rest);
      return 'continue';
    case 'resources':
    case 'resource':
      await resourcesCommand(ctx, rest);
      return 'continue';
    case 'prompts':
    case 'prompt':
      await promptsCommand(ctx, rest);
      return 'continue';
    case 'github':
      await githubCommand(ctx, rest);
      return 'continue';
    case 'elevenlabs':
      await elevenlabsCommand(ctx, rest);
      return 'continue';
    case 'firebase':
      await firebaseCommand(ctx, rest);
      return 'continue';
    case 'discover':
      await discoverCommand(ctx, rest);
      return 'continue';
    case 'json':
      ctx.out.opts.json = onOff(rest[0], ctx.out.opts.json);
      ctx.out.info(`Mode JSON : ${ctx.out.opts.json ? 'activé' : 'désactivé'}`);
      if (ctx.out.opts.json) ctx.out.data({ json: true }, () => '');
      return 'continue';
    case 'quiet':
      ctx.out.opts.quiet = onOff(rest[0], ctx.out.opts.quiet);
      ctx.out.info(`Mode silencieux : ${ctx.out.opts.quiet ? 'activé' : 'désactivé'}`);
      return 'continue';
    case 'help':
    case '?':
      ctx.out.data({ commands: HELP_LINES.map(([command, description]) => ({ command, description })) }, renderHelp);
      return 'continue';
    case 'exit':
    case 'quit':
      return 'exit';
    default:
      throw new McpTerminalError('UNKNOWN_COMMAND', `Commande inconnue : ${rawGroup}`, 'Tapez /help pour la liste des commandes.');
  }
}

/* ------------------------------------------------------------------ /servers */

async function serversCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { style } = ctx.out;
  if (sub === undefined || sub === 'list') {
    const views = await ctx.servers.list();
    ctx.out.data({ servers: views }, () => {
      if (views.length === 0) return 'Aucun serveur configuré. Ajoutez-en un avec /servers add.';
      const table = renderTable(
        ['NOM', 'TRANSPORT', 'CIBLE', 'ÉTAT'],
        views.map((v) => [`${v.name}${v.isDefault ? ' *' : ''}`, v.transport, v.target, v.connected ? 'connecté' : '—']),
        style,
      );
      const details = views.flatMap((v) => [
        ...Object.entries(v.env).map(([key, value]) => style.dim(`  ${v.name} · env ${key}=${value}`)),
        ...Object.entries(v.headers).map(([key, value]) => style.dim(`  ${v.name} · en-tête ${key}: ${value}`)),
      ]);
      return [table, ...(details.length > 0 ? ['', ...details] : []), '', style.dim('* = serveur par défaut')].join('\n');
    });
    return;
  }

  if (sub === 'add') {
    const { values, positionals } = guard(() =>
      parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
        options: {
          stdio: { type: 'string' },
          http: { type: 'string' },
          sse: { type: 'string' },
          env: { type: 'string', multiple: true },
          header: { type: 'string', multiple: true },
          cwd: { type: 'string' },
          force: { type: 'boolean' },
        },
      }),
    );
    const name = argAt(positionals, 0, '<nom>');
    const targets: Array<[ServerKind, string]> = [];
    if (values.stdio !== undefined) targets.push(['stdio', values.stdio]);
    if (values.http !== undefined) targets.push(['http', values.http]);
    if (values.sse !== undefined) targets.push(['sse', values.sse]);
    const chosen = targets[0];
    if (targets.length !== 1 || chosen === undefined) {
      throw new McpTerminalError('INVALID_ARGUMENT', 'Indiquez exactement une option parmi --stdio, --http, --sse.');
    }
    const spec: AddServerSpec = {
      name,
      kind: chosen[0],
      target: chosen[1],
      env: parseKeyValues(values.env, 'env'),
      headers: parseKeyValues(values.header, 'header'),
      overwrite: values.force === true,
      ...(values.cwd !== undefined ? { cwd: values.cwd } : {}),
      ...(ctx.globals.timeoutMs !== undefined ? { timeoutMs: ctx.globals.timeoutMs } : {}),
    };
    const { server, warnings } = await ctx.servers.add(spec);
    for (const warning of warnings) ctx.out.warn(warning);
    ctx.out.data({ added: server, warnings }, () => `${style.green('✔')} Serveur "${server.name}" ajouté (${server.transport}) : ${server.target}`);
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    const { positionals } = guard(() => parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: {} }));
    const name = argAt(positionals, 0, '<nom>');
    if (!(await ctx.io.confirm(`Supprimer le serveur "${name}" de la configuration ?`))) {
      throw new McpTerminalError('CANCELLED', 'Suppression annulée.');
    }
    await ctx.servers.remove(name);
    ctx.out.data({ removed: name }, () => `${style.green('✔')} Serveur "${name}" supprimé.`);
    return;
  }

  if (sub === 'connect') {
    const name = argAt(rest, 0, '<nom>');
    const summary = await ctx.servers.connect(name, { setDefault: !ctx.interactive });
    ctx.out.data({ connected: true, server: summary }, () => renderSummary(ctx, summary));
    if (!ctx.interactive) {
      ctx.out.info(style.dim(`(Mode commande unique : la connexion se ferme à la fin ; "${name}" est désormais le serveur par défaut.)`));
    }
    return;
  }

  if (sub === 'disconnect') {
    const closed = await ctx.servers.disconnect(rest[0]);
    ctx.out.data({ disconnected: closed }, () => (closed.length > 0 ? `Déconnecté : ${closed.join(', ')}` : 'Aucune connexion active.'));
    return;
  }

  if (sub === 'status') {
    const status = await ctx.servers.status();
    ctx.out.data(status, () =>
      [
        title(style, 'STATUT'),
        `Serveur actif    : ${status.active ?? '—'}`,
        `Serveur par défaut : ${status.defaultServer ?? '—'}`,
        status.connections.length > 0
          ? ['Connexions :', ...status.connections.map((c) => `  • ${c.name} (${c.transport}) depuis ${c.connectedAt}`)].join('\n')
          : 'Connexions       : aucune',
      ].join('\n'),
    );
    return;
  }

  if (sub === 'info') {
    const summary = await ctx.servers.info(rest[0] ?? ctx.globals.server);
    ctx.out.data({ server: summary }, () => renderSummary(ctx, summary));
    return;
  }

  if (sub === 'test') {
    const name = argAt(rest, 0, '<nom>');
    const report = await ctx.servers.test(name);
    ctx.out.data(report, () =>
      [
        `${style.green('✔')} "${report.name}" répond (${report.transport})`,
        `  connexion : ${report.connectMs} ms`,
        `  ping      : ${report.pingMs === null ? 'non supporté' : `${report.pingMs} ms`}`,
        `  tools     : ${report.counts.tools ?? '?'}   resources : ${report.counts.resources ?? '?'}   prompts : ${report.counts.prompts ?? '?'}`,
      ].join('\n'),
    );
    return;
  }

  throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /servers ${sub}`, 'Tapez /help.');
}

function renderSummary(ctx: CommandContext, summary: { name: string; transport: string; serverInfo: unknown; capabilities: unknown; instructions: string | null }): string {
  const { style } = ctx.out;
  const info = asRecord(summary.serverInfo);
  const capabilities = Object.keys(asRecord(summary.capabilities) ?? {});
  return [
    `${style.green('✔')} Connecté à "${summary.name}" (${summary.transport})`,
    `  Serveur      : ${text(info?.['name'], 'inconnu')} ${text(info?.['version'])}`.trimEnd(),
    `  Capabilities : ${capabilities.length > 0 ? capabilities.join(', ') : 'aucune annoncée'}`,
    ...(summary.instructions ? [`  Instructions : ${summary.instructions}`] : []),
  ].join('\n');
}

/* ------------------------------------------------------------------- /tools */

const DESTRUCTIVE_NAME = /(delete|remove|drop|destroy|purge|truncate|wipe|reset|revoke|erase|kill)/i;

async function confirmIfDestructive(ctx: CommandContext, tool: ToolInfo): Promise<void> {
  const annotations = asRecord(asRecord(tool)?.['annotations']);
  const explicit = annotations?.['destructiveHint'] === true;
  const guessed = annotations?.['readOnlyHint'] !== true && DESTRUCTIVE_NAME.test(tool.name);
  if (!explicit && !guessed) return;
  if (!(await ctx.io.confirm(`Le tool "${tool.name}" peut être destructeur. Continuer ?`))) {
    throw new McpTerminalError('CANCELLED', 'Appel annulé.');
  }
}

function checkRequired(tool: ToolInfo, input: Record<string, unknown>): void {
  const schema = asRecord(asRecord(tool)?.['inputSchema']);
  const required = Array.isArray(schema?.['required']) ? schema['required'].filter((v): v is string => typeof v === 'string') : [];
  const missing = required.filter((key) => !(key in input));
  if (missing.length > 0) {
    throw new McpTerminalError(
      'INVALID_ARGUMENT',
      `Paramètres requis manquants pour "${tool.name}" : ${missing.join(', ')}.`,
      `Consultez /tools describe ${tool.name}.`,
    );
  }
}

function emitToolResult(ctx: CommandContext, server: string, tool: string, input: Record<string, unknown>, result: ToolCallResult): void {
  const isError = result.isError === true;
  if (isError) ctx.state.exitCode = 1;
  const payload = {
    server,
    tool,
    arguments: input,
    isError,
    content: result.content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
  ctx.out.data(payload, () => renderToolResult(result, ctx.out.style));
}

async function toolsCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { style } = ctx.out;
  const clients = ctx.servers.clients;

  if (sub === undefined || sub === 'list') {
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const tools = await clients.listTools(server);
    ctx.out.data(
      { server, tools: tools.map((tool) => ({ name: tool.name, description: asRecord(tool)?.['description'] ?? null })) },
      () =>
        [
          `Connected server: ${server}`,
          '',
          title(style, 'TOOLS'),
          ...(tools.length > 0
            ? tools.map((tool) => {
                const description = text(asRecord(tool)?.['description']).split('\n')[0] ?? '';
                return description !== '' ? `${tool.name}  ${style.dim(`— ${description}`)}` : tool.name;
              })
            : ['(aucun tool exposé)']),
        ].join('\n'),
    );
    return;
  }

  if (sub === 'describe') {
    const name = argAt(rest, 0, '<tool>');
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const tool = await clients.getTool(server, name);
    ctx.out.data({ server, tool }, () => renderToolDescription(tool, style));
    return;
  }

  if (sub === 'call') {
    const { values, positionals } = guard(() =>
      parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: { 'input-json': { type: 'string' } } }),
    );
    const name = argAt(positionals, 0, '<tool>');
    const raw = values['input-json'] ?? positionals[1];
    const input = raw === undefined ? {} : parseJsonObject(raw, 'Arguments du tool');
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const tool = await clients.getTool(server, name);
    checkRequired(tool, input);
    await confirmIfDestructive(ctx, tool);
    const result = await clients.callTool(server, name, input, ctx.globals.timeoutMs);
    emitToolResult(ctx, server, name, input, result);
    return;
  }

  throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /tools ${sub}`, 'Tapez /help.');
}

/* ---------------------------------------------------------------- /resources */

function renderResourceContents(output: ReadResourceOutput, ctx: CommandContext): string {
  const { style } = ctx.out;
  return output.contents
    .map((item) => {
      const record = asRecord(item) ?? {};
      const header = style.cyan(`${text(record['uri'], 'resource')}${record['mimeType'] !== undefined ? ` (${text(record['mimeType'])})` : ''}`);
      const body =
        typeof record['text'] === 'string'
          ? record['text']
          : style.dim(`[contenu binaire ${formatBytes(Math.floor((text(record['blob']).length * 3) / 4))} — utilisez --json]`);
      return `${header}\n${body}`;
    })
    .join('\n\n');
}

async function resourcesCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { style } = ctx.out;
  const clients = ctx.servers.clients;
  if (sub === undefined || sub === 'list') {
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const resources = await clients.listResources(server);
    ctx.out.data({ server, resources }, () =>
      resources.length === 0
        ? 'Aucune resource exposée.'
        : renderTable(
            ['URI', 'NOM', 'TYPE'],
            resources.map((r) => {
              const record = asRecord(r) ?? {};
              return [text(record['uri']), text(record['name']), text(record['mimeType'], '—')];
            }),
            style,
          ),
    );
    return;
  }
  if (sub === 'read') {
    const uri = argAt(rest, 0, '<uri>');
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const output = await clients.readResource(server, uri);
    ctx.out.data({ server, uri, contents: output.contents }, () => renderResourceContents(output, ctx));
    return;
  }
  throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /resources ${sub}`, 'Tapez /help.');
}

/* ------------------------------------------------------------------ /prompts */

function renderPrompt(output: GetPromptOutput, ctx: CommandContext): string {
  const { style } = ctx.out;
  const header = typeof output.description === 'string' && output.description !== '' ? [style.dim(output.description), ''] : [];
  return [
    ...header,
    ...output.messages.map((message) => {
      const record = asRecord(message) ?? {};
      return `${style.bold(`[${text(record['role'], '?')}]`)} ${renderPromptContent(record['content'], ctx)}`;
    }),
  ].join('\n');
}

function renderPromptContent(content: unknown, ctx: CommandContext): string {
  const record = asRecord(content);
  if (record && record['type'] === 'text') return text(record['text']);
  return ctx.out.style.dim(JSON.stringify(content));
}

async function promptsCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { style } = ctx.out;
  const clients = ctx.servers.clients;
  if (sub === undefined || sub === 'list') {
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const prompts = await clients.listPrompts(server);
    ctx.out.data({ server, prompts }, () =>
      prompts.length === 0
        ? 'Aucun prompt exposé.'
        : renderTable(
            ['NOM', 'ARGUMENTS', 'DESCRIPTION'],
            prompts.map((p) => {
              const record = asRecord(p) ?? {};
              const promptArgs = Array.isArray(record['arguments']) ? record['arguments'] : [];
              const names = promptArgs.map((a) => `${text(asRecord(a)?.['name'])}${asRecord(a)?.['required'] === true ? '*' : ''}`);
              return [text(record['name']), names.join(', ') || '—', text(record['description'])];
            }),
            style,
          ),
    );
    return;
  }
  if (sub === 'get') {
    const { values, positionals } = guard(() =>
      parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: { args: { type: 'string' } } }),
    );
    const name = argAt(positionals, 0, '<nom>');
    const promptArgs: Record<string, string> = {};
    if (values.args !== undefined) {
      for (const [key, value] of Object.entries(parseJsonObject(values.args, 'Arguments du prompt'))) {
        promptArgs[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    for (const pair of positionals.slice(1)) {
      const index = pair.indexOf('=');
      if (index <= 0) throw new McpTerminalError('INVALID_ARGUMENT', `Argument de prompt invalide : "${pair}" (format cle=valeur).`);
      promptArgs[pair.slice(0, index)] = pair.slice(index + 1);
    }
    const server = await ctx.servers.ensureConnected(ctx.globals.server);
    const output = await clients.getPrompt(server, name, promptArgs);
    ctx.out.data({ server, prompt: name, ...output }, () => renderPrompt(output, ctx));
    return;
  }
  throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /prompts ${sub}`, 'Tapez /help.');
}

/* ------------------------------------------------------------ raccourcis (providers) */

async function providerRun(ctx: CommandContext, runner: (backend: ProviderBackend) => Promise<ProviderRun>): Promise<void> {
  const server = await ctx.servers.ensureConnected(ctx.globals.server);
  const clients = ctx.servers.clients;
  const backend: ProviderBackend = {
    listTools: () => clients.listTools(server),
    callTool: (tool, args) => clients.callTool(server, tool, args, ctx.globals.timeoutMs),
  };
  const run = await runner(backend);
  ctx.out.info(ctx.out.style.dim(`→ tool utilisé : ${run.tool.name}`));
  emitToolResult(ctx, server, run.tool.name, run.arguments, run.result);
}

function extraFrom(raw: string | undefined): Record<string, unknown> | undefined {
  return raw === undefined ? undefined : parseJsonObject(raw, '--input-json');
}

async function githubCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = guard(() =>
    parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        owner: { type: 'string' },
        query: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
        draft: { type: 'boolean' },
        'input-json': { type: 'string' },
      },
    }),
  );
  const extra = extraFrom(values['input-json']);
  if (sub === 'list-repos') {
    await providerRun(ctx, (backend) =>
      listRepos(backend, {
        ...(values.owner !== undefined ? { owner: values.owner } : {}),
        ...(values.query !== undefined ? { query: values.query } : {}),
        ...(extra !== undefined ? { extra } : {}),
      }),
    );
  } else if (sub === 'get-issue') {
    const repo = argAt(positionals, 0, '<repo>');
    const number = argAt(positionals, 1, '<numéro>');
    await providerRun(ctx, (backend) => getIssue(backend, repo, number, extra));
  } else if (sub === 'create-pr') {
    const repo = argAt(positionals, 0, '<repo>');
    const prTitle = argAt(positionals, 1, '<titre>');
    await providerRun(ctx, (backend) =>
      createPullRequest(backend, repo, prTitle, {
        ...(values.head !== undefined ? { head: values.head } : {}),
        ...(values.base !== undefined ? { base: values.base } : {}),
        ...(values.body !== undefined ? { body: values.body } : {}),
        ...(values.draft === true ? { draft: true } : {}),
        ...(extra !== undefined ? { extra } : {}),
      }),
    );
  } else {
    throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /github ${sub ?? ''}`.trimEnd(), 'list-repos | get-issue <repo> <n> | create-pr <repo> <titre>');
  }
}

async function elevenlabsCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = guard(() =>
    parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        voice: { type: 'string' },
        'voice-id': { type: 'string' },
        model: { type: 'string' },
        'input-json': { type: 'string' },
      },
    }),
  );
  const extra = extraFrom(values['input-json']);
  if (sub === 'voices') {
    await providerRun(ctx, (backend) => listVoices(backend, extra));
  } else if (sub === 'tts') {
    const content = positionals.join(' ');
    if (content.trim() === '') throw new McpTerminalError('INVALID_ARGUMENT', 'Argument manquant : <texte>');
    await providerRun(ctx, (backend) =>
      textToSpeech(backend, content, {
        ...(values.voice !== undefined ? { voice: values.voice } : {}),
        ...(values['voice-id'] !== undefined ? { voiceId: values['voice-id'] } : {}),
        ...(values.model !== undefined ? { model: values.model } : {}),
        ...(extra !== undefined ? { extra } : {}),
      }),
    );
  } else {
    throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /elevenlabs ${sub ?? ''}`.trimEnd(), 'voices | tts <texte>');
  }
}

async function firebaseCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = guard(() =>
    parseArgs({ args: [...rest], allowPositionals: true, strict: true, options: { 'input-json': { type: 'string' } } }),
  );
  const extra = extraFrom(values['input-json']);
  if (sub === 'list-collections') {
    await providerRun(ctx, (backend) => listCollections(backend, extra));
  } else if (sub === 'get') {
    const collection = argAt(positionals, 0, '<collection>');
    const document = argAt(positionals, 1, '<document>');
    await providerRun(ctx, (backend) => getDocument(backend, collection, document, extra));
  } else if (sub === 'add') {
    const collection = argAt(positionals, 0, '<collection>');
    const json = argAt(positionals, 1, '<json>');
    await providerRun(ctx, (backend) => addDocument(backend, collection, json, extra));
  } else {
    throw new McpTerminalError('UNKNOWN_COMMAND', `Sous-commande inconnue : /firebase ${sub ?? ''}`.trimEnd(), 'list-collections | get <col> <doc> | add <col> <json>');
  }
}

/* ----------------------------------------------------------------- /discover */

async function discoverCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const { values, positionals } = guard(() =>
    parseArgs({ args: [...args], allowPositionals: true, strict: true, options: { limit: { type: 'string' } } }),
  );
  const limit = values.limit === undefined ? 20 : Number.parseInt(values.limit, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new McpTerminalError('INVALID_ARGUMENT', '--limit attend un entier entre 1 et 100.');
  }
  const term = positionals.join(' ').trim();
  const result = await discover(term === '' ? undefined : term, { ...ctx.discoveryOptions, limit });
  ctx.out.data({ query: result.query, count: result.entries.length, servers: result.entries }, () =>
    renderRegistry(result.entries, ctx.out.style),
  );
}
