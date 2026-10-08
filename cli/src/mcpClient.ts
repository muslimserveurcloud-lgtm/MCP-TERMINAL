import {
  Client,
  SSEClientTransport,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { FetchLike, Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { McpTerminalError, toTerminalError } from './errors.js';
import { logger } from './logger.js';
import { APP_NAME, APP_VERSION } from './types.js';
import type { ResolvedHttp, ResolvedServer, ResolvedStdio } from './types.js';

/* Les types de résultats sont dérivés des signatures du SDK : aucun type MCP n'est redéclaré ici. */
export type ToolInfo = Awaited<ReturnType<Client['listTools']>>['tools'][number];
export type ResourceInfo = Awaited<ReturnType<Client['listResources']>>['resources'][number];
export type PromptInfo = Awaited<ReturnType<Client['listPrompts']>>['prompts'][number];
export type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;
export type ReadResourceOutput = Awaited<ReturnType<Client['readResource']>>;
export type GetPromptOutput = Awaited<ReturnType<Client['getPrompt']>>;

export interface ClientManagerOptions {
  /** fetch personnalisé pour le transport Streamable HTTP (utilisé par les tests, sans réseau). */
  fetch?: FetchLike;
}

export interface ConnectionSummary {
  name: string;
  transport: string;
  connectedAt: string;
  serverInfo: unknown;
  capabilities: unknown;
  instructions: string | null;
}

export interface TestReport {
  name: string;
  ok: true;
  transport: string;
  connectMs: number;
  pingMs: number | null;
  serverInfo: unknown;
  capabilities: unknown;
  counts: { tools: number | null; resources: number | null; prompts: number | null };
}

interface Connection {
  name: string;
  transport: string;
  client: Client;
  connectedAt: Date;
  timeoutMs: number;
}

/** Variables d'environnement non secrètes transmises en plus des variables par défaut du SDK (utile sous Termux). */
const EXTRA_SAFE_ENV = [
  'PREFIX',
  'TMPDIR',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'ANDROID_ROOT',
  'ANDROID_DATA',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
] as const;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpTerminalError('TIMEOUT', `Délai dépassé (${ms} ms) : ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    logger.debug(`Fermeture : ${toTerminalError(error).message}`);
  }
}

function toPlain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

export class McpClientManager {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly options: ClientManagerOptions = {}) {}

  /* ---------------------------------------------------------------- connexion */

  async connect(server: ResolvedServer): Promise<ConnectionSummary> {
    const existing = this.connections.get(server.name);
    if (existing) return this.summarize(existing);
    const connection = await this.open(server);
    this.connections.set(server.name, connection);
    return this.summarize(connection);
  }

  async disconnect(name: string): Promise<boolean> {
    const connection = this.connections.get(name);
    if (!connection) return false;
    this.connections.delete(name);
    await safeClose(connection.client);
    return true;
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  isConnected(name: string): boolean {
    return this.connections.has(name);
  }

  connectedNames(): string[] {
    return [...this.connections.keys()];
  }

  list(): ConnectionSummary[] {
    return [...this.connections.values()].map((connection) => this.summarize(connection));
  }

  info(name: string): ConnectionSummary {
    return this.summarize(this.require(name));
  }

  /** Connecte temporairement un serveur, mesure la latence et compte les primitives. */
  async test(server: ResolvedServer): Promise<TestReport> {
    const started = Date.now();
    const alreadyConnected = this.connections.get(server.name);
    const connection = alreadyConnected ?? (await this.open(server));
    try {
      const connectMs = Date.now() - started;
      let pingMs: number | null = null;
      try {
        const t0 = Date.now();
        await connection.client.ping({ timeout: Math.min(connection.timeoutMs, 5_000) });
        pingMs = Date.now() - t0;
      } catch {
        pingMs = null;
      }
      const count = async <T>(fn: () => Promise<T[]>): Promise<number | null> => {
        try {
          return (await fn()).length;
        } catch {
          return null;
        }
      };
      const summary = this.summarize(connection);
      return {
        name: server.name,
        ok: true,
        transport: connection.transport,
        connectMs,
        pingMs,
        serverInfo: summary.serverInfo,
        capabilities: summary.capabilities,
        counts: {
          tools: await count(() => this.listTools(server.name, connection)),
          resources: await count(() => this.listResources(server.name, connection)),
          prompts: await count(() => this.listPrompts(server.name, connection)),
        },
      };
    } finally {
      if (!alreadyConnected) await safeClose(connection.client);
    }
  }

  /* -------------------------------------------------------------------- tools */

  async listTools(name: string, via?: Connection): Promise<ToolInfo[]> {
    const connection = via ?? this.require(name);
    const result = await connection.client.listTools(undefined, { timeout: connection.timeoutMs });
    return result.tools;
  }

  async getTool(name: string, toolName: string): Promise<ToolInfo> {
    const tools = await this.listTools(name);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new McpTerminalError(
        'TOOL_NOT_FOUND',
        `Le serveur "${name}" n'expose pas de tool "${toolName}".`,
        tools.length > 0 ? `Tools disponibles : ${tools.map((t) => t.name).join(', ')}.` : 'Ce serveur n\'expose aucun tool.',
      );
    }
    return tool;
  }

  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ToolCallResult> {
    const connection = this.require(name);
    try {
      return await connection.client.callTool(
        { name: toolName, arguments: args },
        { timeout: timeoutMs ?? connection.timeoutMs },
      );
    } catch (error) {
      throw toTerminalError(error);
    }
  }

  /* ---------------------------------------------------------------- resources */

  async listResources(name: string, via?: Connection): Promise<ResourceInfo[]> {
    const connection = via ?? this.require(name);
    const result = await connection.client.listResources(undefined, { timeout: connection.timeoutMs });
    return result.resources;
  }

  async readResource(name: string, uri: string): Promise<ReadResourceOutput> {
    const connection = this.require(name);
    try {
      return await connection.client.readResource({ uri }, { timeout: connection.timeoutMs });
    } catch (error) {
      throw toTerminalError(error);
    }
  }

  /* ------------------------------------------------------------------ prompts */

  async listPrompts(name: string, via?: Connection): Promise<PromptInfo[]> {
    const connection = via ?? this.require(name);
    const result = await connection.client.listPrompts(undefined, { timeout: connection.timeoutMs });
    return result.prompts;
  }

  async getPrompt(name: string, promptName: string, args: Record<string, string>): Promise<GetPromptOutput> {
    const connection = this.require(name);
    try {
      return await connection.client.getPrompt(
        { name: promptName, arguments: args },
        { timeout: connection.timeoutMs },
      );
    } catch (error) {
      throw toTerminalError(error);
    }
  }

  /* ------------------------------------------------------------------ interne */

  private require(name: string): Connection {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new McpTerminalError(
        'NOT_CONNECTED',
        `Le serveur "${name}" n'est pas connecté.`,
        'Utilisez /servers connect <nom>.',
      );
    }
    return connection;
  }

  private summarize(connection: Connection): ConnectionSummary {
    const { client } = connection;
    return {
      name: connection.name,
      transport: connection.transport,
      connectedAt: connection.connectedAt.toISOString(),
      serverInfo: toPlain(client.getServerVersion()),
      capabilities: toPlain(client.getServerCapabilities()),
      instructions: client.getInstructions() ?? null,
    };
  }

  private newClient(server: ResolvedServer): Client {
    const info = { name: APP_NAME, version: APP_VERSION };
    // Négociation automatique de la révision de protocole proposée par le SDK (désactivable par serveur).
    return server.negotiate ? new Client(info, { versionNegotiation: { mode: 'auto' } }) : new Client(info);
  }

  private async attempt(server: ResolvedServer, transport: Transport): Promise<Client> {
    const client = this.newClient(server);
    try {
      await withTimeout(client.connect(transport), server.timeoutMs, `connexion à "${server.name}"`);
      return client;
    } catch (error) {
      await safeClose(client);
      throw error;
    }
  }

  private async open(server: ResolvedServer): Promise<Connection> {
    try {
      let client: Client;
      let transportName: string = server.transport;
      if (server.transport === 'stdio') {
        client = await this.attempt(server, this.stdioTransport(server));
      } else if (server.transport === 'sse') {
        client = await this.attempt(server, this.sseTransport(server));
      } else {
        try {
          client = await this.attempt(server, this.httpTransport(server));
        } catch (error) {
          // Repli HTTP+SSE legacy uniquement quand le serveur ne parle pas Streamable HTTP.
          if (error instanceof SdkHttpError && [400, 404, 405].includes(Number(error.status))) {
            logger.info(`Streamable HTTP indisponible pour "${server.name}" (HTTP ${String(error.status)}) : repli sur SSE legacy.`);
            client = await this.attempt(server, this.sseTransport(server));
            transportName = 'sse (legacy)';
          } else {
            throw error;
          }
        }
      }
      return { name: server.name, transport: transportName, client, connectedAt: new Date(), timeoutMs: server.timeoutMs };
    } catch (error) {
      throw this.connectionError(server, error);
    }
  }

  private connectionError(server: ResolvedServer, error: unknown): McpTerminalError {
    const base = toTerminalError(error);
    if (base.code === 'TIMEOUT') return base;
    const hint =
      server.transport === 'stdio'
        ? `Vérifiez la commande "${server.command}" (installée, dans le PATH) et lancez-la seule pour voir ses erreurs.`
        : "Vérifiez l'URL, le réseau et les en-têtes d'authentification (variables d'environnement).";
    return new McpTerminalError('CONNECTION_FAILED', `Connexion à "${server.name}" impossible : ${base.message}`, hint);
  }

  private stdioTransport(server: ResolvedStdio): Transport {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const key of EXTRA_SAFE_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, server.env);
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env,
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    });
  }

  private httpTransport(server: ResolvedHttp): Transport {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
    });
  }

  private sseTransport(server: ResolvedHttp): Transport {
    const headers = server.headers;
    // Les en-têtes doivent aussi accompagner la requête GET d'ouverture du flux SSE.
    const options = {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (url: string | URL, init?: RequestInit): Promise<Response> => {
          const merged = new Headers(init?.headers);
          for (const [key, value] of Object.entries(headers)) merged.set(key, value);
          return fetch(url, { ...init, headers: merged });
        },
      },
    } as unknown as NonNullable<ConstructorParameters<typeof SSEClientTransport>[1]>;
    return new SSEClientTransport(new URL(server.url), options);
  }
}
