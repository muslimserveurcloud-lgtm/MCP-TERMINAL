import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as readline from 'node:readline';
import { createIo, extractGlobals, runCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import { tokenize } from './config.js';
import { toTerminalError } from './errors.js';
import { redact } from './logger.js';
import { APP_NAME, APP_VERSION } from './types.js';

export interface ReplOptions {
  historyPath: string;
}

const COMMAND_TREE: Readonly<Record<string, readonly string[]>> = {
  '/servers': ['list', 'add', 'remove', 'connect', 'disconnect', 'status', 'info', 'test'],
  '/tools': ['list', 'describe', 'call'],
  '/resources': ['list', 'read'],
  '/prompts': ['list', 'get'],
  '/github': ['list-repos', 'get-issue', 'create-pr'],
  '/elevenlabs': ['voices', 'tts'],
  '/firebase': ['list-collections', 'get', 'add'],
  '/discover': ['github', 'firebase', 'elevenlabs', 'database', 'ai', 'media'],
  '/json': ['on', 'off'],
  '/quiet': ['on', 'off'],
  '/help': [],
  '/exit': [],
};

const SERVER_NAME_SUBCOMMANDS = new Set(['connect', 'remove', 'rm', 'test', 'disconnect', 'info']);
const TOOL_NAME_SUBCOMMANDS = new Set(['describe', 'call']);
const HISTORY_SIZE = 500;
const SENSITIVE_LINE = /(token|secret|passw(or)?d|api[_-]?key|bearer|authorization)/i;

async function loadHistory(path: string): Promise<string[]> {
  try {
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
    return lines.slice(-HISTORY_SIZE).reverse(); // readline attend la plus récente en premier
  } catch {
    return [];
  }
}

async function saveHistory(path: string, line: string): Promise<void> {
  // On ne persiste jamais une ligne qui semble contenir un secret.
  if (SENSITIVE_LINE.test(line) || redact(line) !== line) return;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${line}\n`, { mode: 0o600 });
  } catch {
    /* l'historique est un confort, pas une obligation */
  }
}

export async function startRepl(baseCtx: CommandContext, options: ReplOptions): Promise<void> {
  const ctx: CommandContext = { ...baseCtx, interactive: true };
  const history = await loadHistory(options.historyPath);
  const known = { servers: [] as string[], tools: [] as string[] };

  const refresh = async (): Promise<void> => {
    try {
      known.servers = await ctx.servers.store.names();
    } catch {
      known.servers = [];
    }
    const active = ctx.servers.getActive();
    if (active !== undefined) {
      try {
        known.tools = (await ctx.servers.clients.listTools(active)).map((tool) => tool.name);
      } catch {
        known.tools = [];
      }
    }
  };
  await refresh();

  const completer = (line: string, callback: (error: Error | null, result: [string[], string]) => void): void => {
    const parts = line.trimStart().split(/\s+/);
    const current = parts[parts.length - 1] ?? '';
    const index = parts.length - 1;
    const first = parts[0] ?? '';
    const group = first.startsWith('/') ? first : `/${first}`;
    let candidates: readonly string[] = [];
    if (index === 0) candidates = Object.keys(COMMAND_TREE);
    else if (index === 1) candidates = COMMAND_TREE[group] ?? [];
    else if (index === 2) {
      const sub = parts[1] ?? '';
      if (group === '/servers' && SERVER_NAME_SUBCOMMANDS.has(sub)) candidates = known.servers;
      else if (group === '/tools' && TOOL_NAME_SUBCOMMANDS.has(sub)) candidates = known.tools;
    }
    callback(null, [candidates.filter((candidate) => candidate.startsWith(current)), current]);
  };

  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'mcp> ',
      history,
      historySize: HISTORY_SIZE,
      removeHistoryDuplicates: true,
      completer,
    });

    const ask = (question: string): Promise<string> => new Promise((answer) => rl.question(question, answer));
    let queue: Promise<void> = Promise.resolve();
    let closing = false;

    const handle = async (rawLine: string): Promise<void> => {
      const line = rawLine.trim();
      if (line === '') return;
      await saveHistory(options.historyPath, line);
      try {
        const extracted = extractGlobals(tokenize(line));
        const yes = extracted.yes || ctx.globals.yes;
        const lineCtx: CommandContext = {
          ...ctx,
          globals: {
            server: extracted.server ?? ctx.globals.server,
            timeoutMs: extracted.timeoutMs ?? ctx.globals.timeoutMs,
            yes,
          },
          io: createIo({ yes, json: false, ask }),
        };
        const tokens = extracted.help && extracted.rest.length === 0 ? ['help'] : extracted.rest;
        if ((await runCommand(lineCtx, tokens)) === 'exit') {
          closing = true;
          rl.close();
          return;
        }
      } catch (error) {
        ctx.out.error(toTerminalError(error));
      }
      await refresh();
    };

    rl.on('line', (line) => {
      queue = queue.then(() => handle(line)).then(() => {
        if (!closing) rl.prompt();
      });
    });

    rl.on('SIGINT', () => {
      if (rl.line.length > 0) {
        rl.write(null, { ctrl: true, name: 'u' });
      } else {
        ctx.out.info('(Ctrl+C) Tapez /exit ou Ctrl+D pour quitter.');
        rl.prompt();
      }
    });

    rl.on('close', () => {
      void queue
        .then(() => ctx.servers.disconnect())
        .catch(() => undefined)
        .then(() => {
          ctx.out.info('');
          resolve();
        });
    });

    ctx.out.info(`${ctx.out.style.bold(`MUSLIM MCP TERMINAL`)} ${ctx.out.style.dim(`(${APP_NAME} v${APP_VERSION})`)}`);
    ctx.out.info(ctx.out.style.dim('Tapez /help pour la liste des commandes, /exit ou Ctrl+D pour quitter.'));
    rl.prompt();
  });
}
