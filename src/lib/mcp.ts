import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike } from '@modelcontextprotocol/client';
import { expandRefs } from './secrets';
import type { Secrets, ServerEntry } from './storage';

export type ToolInfo = Awaited<ReturnType<Client['listTools']>>['tools'][number];
export type ResourceInfo = Awaited<ReturnType<Client['listResources']>>['resources'][number];
export type PromptInfo = Awaited<ReturnType<Client['listPrompts']>>['prompts'][number];
export type ToolResult = Awaited<ReturnType<Client['callTool']>>;
export type ResourceResult = Awaited<ReturnType<Client['readResource']>>;
export type PromptResult = Awaited<ReturnType<Client['getPrompt']>>;

export interface Session {
  server: ServerEntry;
  client: Client;
  timeoutMs: number;
  info: unknown;
  capabilities: unknown;
  instructions: string | null;
}

export class TimeoutError extends Error {}

const CLIENT_INFO = { name: 'muslim-mcp-terminal-mobile', version: '1.0.0' };

/**
 * Sur Android, CapacitorHttp remplace window.fetch par une requête native qui renvoie la réponse complète
 * (sans flux). Le flux SSE « serveur → client » optionnel (GET) ne peut donc pas être ouvert : on répond 405,
 * ce que la spécification Streamable HTTP autorise. Les réponses aux POST restent pleinement supportées.
 */
const mobileFetch: FetchLike = async (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const accept = new Headers(init?.headers).get('accept') ?? '';
  if (method === 'GET' && accept.includes('text/event-stream')) return new Response(null, { status: 405 });
  return window.fetch(input, init);
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Délai dépassé (${Math.round(ms / 1000)} s) : ${label}`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

const plain = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

export async function connectServer(server: ServerEntry, secrets: Secrets, timeoutMs = 30_000): Promise<Session> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers)) headers[name] = expandRefs(value, secrets);
  const url = expandRefs(server.url, secrets);

  let firstError: unknown;
  // 1) négociation de protocole automatique du SDK ; 2) repli sur la négociation par défaut pour les serveurs anciens.
  for (const negotiate of [true, false]) {
    const client = negotiate ? new Client(CLIENT_INFO, { versionNegotiation: { mode: 'auto' } }) : new Client(CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, fetch: mobileFetch });
    try {
      await withTimeout(client.connect(transport), timeoutMs, `connexion à « ${server.name} »`);
      return {
        server,
        client,
        timeoutMs,
        info: plain(client.getServerVersion()),
        capabilities: plain(client.getServerCapabilities()),
        instructions: client.getInstructions() ?? null,
      };
    } catch (error) {
      firstError ??= error;
      try { await client.close(); } catch { /* ignoré */ }
      if (error instanceof TimeoutError) break;
    }
  }
  throw firstError;
}

export async function closeSession(session: Session): Promise<void> {
  try { await session.client.close(); } catch { /* ignoré */ }
}

export interface TestReport { connectMs: number; pingMs: number | null; tools: number | null; resources: number | null; prompts: number | null; info: unknown }

export async function testServer(server: ServerEntry, secrets: Secrets): Promise<TestReport> {
  const started = Date.now();
  const session = await connectServer(server, secrets);
  try {
    const connectMs = Date.now() - started;
    let pingMs: number | null = null;
    try {
      const t0 = Date.now();
      await session.client.ping({ timeout: 5_000 });
      pingMs = Date.now() - t0;
    } catch { pingMs = null; }
    const count = async (fn: () => Promise<unknown[]>): Promise<number | null> => {
      try { return (await fn()).length; } catch { return null; }
    };
    return {
      connectMs,
      pingMs,
      info: session.info,
      tools: await count(() => listTools(session)),
      resources: await count(() => listResources(session)),
      prompts: await count(() => listPrompts(session)),
    };
  } finally {
    await closeSession(session);
  }
}

const opts = (s: Session) => ({ timeout: s.timeoutMs });

export const listTools = async (s: Session): Promise<ToolInfo[]> => (await s.client.listTools(undefined, opts(s))).tools;
export const listResources = async (s: Session): Promise<ResourceInfo[]> => (await s.client.listResources(undefined, opts(s))).resources;
export const listPrompts = async (s: Session): Promise<PromptInfo[]> => (await s.client.listPrompts(undefined, opts(s))).prompts;
export const callTool = (s: Session, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  s.client.callTool({ name, arguments: args }, opts(s));
export const readResource = (s: Session, uri: string): Promise<ResourceResult> => s.client.readResource({ uri }, opts(s));
export const getPrompt = (s: Session, name: string, args: Record<string, string>): Promise<PromptResult> =>
  s.client.getPrompt({ name, arguments: args }, opts(s));

export const DESTRUCTIVE_NAME = /(delete|remove|drop|destroy|purge|truncate|wipe|reset|revoke|erase|kill)/i;

export function isDestructive(tool: ToolInfo): boolean {
  const annotations = (tool as { annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }).annotations;
  return annotations?.destructiveHint === true || (annotations?.readOnlyHint !== true && DESTRUCTIVE_NAME.test(tool.name));
}
