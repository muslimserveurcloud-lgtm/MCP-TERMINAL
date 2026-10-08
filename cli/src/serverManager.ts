import {
  ConfigStore,
  assertNoLiteralSecrets,
  assertNoSecretArgs,
  containsEnvRef,
  formatZodIssues,
  resolveServer,
  tokenize,
  validateUrl,
} from './config.js';
import { McpTerminalError } from './errors.js';
import { redact } from './logger.js';
import type { ConnectionSummary, McpClientManager, TestReport } from './mcpClient.js';
import { ServerConfigSchema } from './types.js';
import type { ServerConfig } from './types.js';

export type ServerKind = 'stdio' | 'http' | 'sse';

export interface AddServerSpec {
  name: string;
  kind: ServerKind;
  /** Commande complète (stdio) ou URL (http / sse). */
  target: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  overwrite: boolean;
}

/** Vue d'un serveur sans aucune valeur secrète : prête à être affichée. */
export interface ServerView {
  name: string;
  transport: string;
  target: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  connected: boolean;
  isDefault: boolean;
}

export interface StatusReport {
  active: string | null;
  defaultServer: string | null;
  connections: Array<{ name: string; transport: string; connectedAt: string }>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function maskValues(map: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    out[key] = containsEnvRef(value) ? value : '***';
  }
  return out;
}

export class ServerManager {
  private active: string | undefined;

  constructor(
    readonly store: ConfigStore,
    readonly clients: McpClientManager,
  ) {}

  getActive(): string | undefined {
    return this.active;
  }

  /* ------------------------------------------------------------------ lecture */

  async view(config: ServerConfig, defaultServer?: string): Promise<ServerView> {
    const target =
      config.transport === 'stdio' ? redact([config.command, ...config.args].join(' ')) : redact(config.url);
    return {
      name: config.name,
      transport: config.transport,
      target,
      env: config.transport === 'stdio' ? maskValues(config.env) : {},
      headers: config.transport === 'stdio' ? {} : maskValues(config.headers),
      connected: this.clients.isConnected(config.name),
      isDefault: defaultServer === config.name,
    };
  }

  async list(): Promise<ServerView[]> {
    const file = await this.store.load();
    const views: ServerView[] = [];
    for (const name of Object.keys(file.servers).sort()) {
      const config = file.servers[name];
      if (config) views.push(await this.view(config, file.defaultServer));
    }
    return views;
  }

  async status(): Promise<StatusReport> {
    const file = await this.store.load();
    return {
      active: this.active ?? null,
      defaultServer: file.defaultServer ?? null,
      connections: this.clients.list().map((c) => ({ name: c.name, transport: c.transport, connectedAt: c.connectedAt })),
    };
  }

  /* ------------------------------------------------------------- modification */

  async add(spec: AddServerSpec): Promise<{ server: ServerView; warnings: string[] }> {
    const warnings: string[] = [];
    assertNoLiteralSecrets('env', spec.env);
    assertNoLiteralSecrets('header', spec.headers);
    for (const key of Object.keys(spec.env)) {
      if (!ENV_NAME.test(key)) throw new McpTerminalError('INVALID_ARGUMENT', `Nom de variable invalide : "${key}"`);
    }
    for (const key of Object.keys(spec.headers)) {
      if (!HEADER_NAME.test(key)) throw new McpTerminalError('INVALID_ARGUMENT', `Nom d'en-tête invalide : "${key}"`);
    }

    let candidate: unknown;
    if (spec.kind === 'stdio') {
      const [command, ...args] = tokenize(spec.target, { rejectOperators: true });
      if (command === undefined || command.startsWith('-')) {
        throw new McpTerminalError('INVALID_ARGUMENT', 'Commande stdio vide ou invalide.', 'Exemple : --stdio "npx -y @modelcontextprotocol/server-filesystem /chemin"');
      }
      assertNoSecretArgs(args);
      candidate = {
        name: spec.name,
        transport: 'stdio',
        command,
        args,
        ...(Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      };
    } else {
      const validated = validateUrl(spec.target);
      warnings.push(...validated.warnings);
      candidate = {
        name: spec.name,
        transport: spec.kind === 'http' ? 'streamable-http' : 'sse',
        url: validated.url,
        ...(Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : {}),
        ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      };
    }

    const parsed = ServerConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new McpTerminalError('INVALID_CONFIG', `Configuration invalide : ${formatZodIssues(parsed.error)}`);
    }
    await this.store.add(parsed.data, spec.overwrite);
    const file = await this.store.load();
    return { server: await this.view(parsed.data, file.defaultServer), warnings };
  }

  async remove(name: string): Promise<void> {
    await this.store.get(name);
    if (this.clients.isConnected(name)) await this.clients.disconnect(name);
    if (this.active === name) this.active = undefined;
    await this.store.remove(name);
  }

  /* ------------------------------------------------------------------ session */

  async connect(name: string, options: { setDefault?: boolean } = {}): Promise<ConnectionSummary> {
    const config = await this.store.get(name);
    const summary = await this.clients.connect(resolveServer(config));
    this.active = name;
    if (options.setDefault === true) await this.store.setDefault(name);
    return summary;
  }

  async disconnect(name?: string): Promise<string[]> {
    const targets = name !== undefined ? [name] : this.clients.connectedNames();
    const closed: string[] = [];
    for (const target of targets) {
      if (await this.clients.disconnect(target)) closed.push(target);
      if (this.active === target) this.active = undefined;
    }
    return closed;
  }

  async test(name: string): Promise<TestReport> {
    const config = await this.store.get(name);
    return this.clients.test(resolveServer(config));
  }

  async info(name?: string): Promise<ConnectionSummary> {
    const target = name ?? this.active ?? this.clients.connectedNames()[0];
    if (target === undefined) {
      throw new McpTerminalError('NOT_CONNECTED', 'Aucun serveur connecté.', 'Utilisez /servers connect <nom>.');
    }
    return this.clients.info(target);
  }

  /**
   * Retourne le nom du serveur à utiliser : explicite, actif, par défaut, ou l'unique serveur configuré.
   * Se connecte à la volée si nécessaire (mode commande unique).
   */
  async ensureConnected(preferred?: string): Promise<string> {
    const file = await this.store.load();
    const names = Object.keys(file.servers);
    const name =
      preferred ??
      this.active ??
      this.clients.connectedNames()[0] ??
      file.defaultServer ??
      (names.length === 1 ? names[0] : undefined);
    if (name === undefined) {
      throw new McpTerminalError(
        'NOT_CONNECTED',
        'Aucun serveur sélectionné.',
        names.length > 0
          ? `Utilisez /servers connect <nom> ou --server <nom> (serveurs : ${names.join(', ')}).`
          : 'Ajoutez un serveur avec /servers add.',
      );
    }
    if (!this.clients.isConnected(name)) await this.connect(name);
    this.active = name;
    return name;
  }
}
