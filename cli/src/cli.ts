#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { createIo, extractGlobals, renderHelp, runCommand } from './commands.js';
import type { CommandContext, ExtractedGlobals } from './commands.js';
import { ConfigStore, getHistoryPath, loadDotEnvFiles } from './config.js';
import { McpTerminalError, toTerminalError } from './errors.js';
import { Output, colorSupported } from './format.js';
import { registerEnvSecrets } from './logger.js';
import { McpClientManager } from './mcpClient.js';
import { startRepl } from './repl.js';
import { ServerManager } from './serverManager.js';
import { APP_NAME, APP_VERSION } from './types.js';

async function askOnce(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<number> {
  loadDotEnvFiles();
  registerEnvSecrets();

  let globals: ExtractedGlobals;
  try {
    globals = extractGlobals(argv);
  } catch (error) {
    new Output({ json: argv.includes('--json'), quiet: false, color: false }).error(toTerminalError(error));
    return 2;
  }

  const color = !globals.noColor && !globals.json && colorSupported();
  const out = new Output({ json: globals.json, quiet: globals.quiet, color });

  if (globals.version) {
    out.data({ name: APP_NAME, version: APP_VERSION }, () => `${APP_NAME} ${APP_VERSION}`);
    return 0;
  }
  if (globals.help) {
    out.data({ usage: 'mcp-terminal [options] [/commande ...]' }, () => `MUSLIM MCP TERMINAL v${APP_VERSION}\n\nUsage : mcp-terminal [options] [/commande ...]\n\n${renderHelp()}`);
    return 0;
  }

  const clients = new McpClientManager();
  const servers = new ServerManager(new ConfigStore(), clients);
  const ask = process.stdin.isTTY === true ? askOnce : undefined;
  const ctx: CommandContext = {
    servers,
    out,
    io: createIo({ yes: globals.yes, json: globals.json, ...(ask !== undefined ? { ask } : {}) }),
    globals: { server: globals.server, timeoutMs: globals.timeoutMs, yes: globals.yes },
    interactive: false,
    state: { exitCode: 0 },
  };

  const onSignal = (): void => {
    void clients.disconnectAll().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (globals.rest.length === 0) {
      await startRepl(ctx, { historyPath: getHistoryPath() });
    } else {
      await runCommand(ctx, globals.rest);
    }
    return ctx.state.exitCode;
  } catch (error) {
    out.error(error instanceof McpTerminalError ? error : toTerminalError(error));
    return 1;
  } finally {
    await clients.disconnectAll();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`Erreur fatale : ${toTerminalError(error).message}\n`);
    process.exit(1);
  },
);
