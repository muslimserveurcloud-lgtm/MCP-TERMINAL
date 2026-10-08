import * as z from 'zod/v4';
import { McpTerminalError } from './errors.js';
import type { Style } from './format.js';

export const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';

/**
 * Mots-clés de recherche (pas une liste de serveurs) : chaque catégorie interroge dynamiquement le registre.
 */
export const CATEGORY_QUERIES: Readonly<Record<string, readonly string[]>> = {
  github: ['github'],
  firebase: ['firebase'],
  elevenlabs: ['elevenlabs'],
  database: ['database', 'postgres', 'sqlite', 'mysql', 'mongodb'],
  ai: ['ai', 'llm', 'openai'],
  media: ['media', 'video', 'audio', 'image'],
};

export interface RegistryEntry {
  name: string;
  title: string | null;
  description: string;
  version: string;
  publisher: string;
  transports: string[];
  install: string[];
  repository: string | null;
  documentation: string | null;
}

export interface DiscoveryOptions {
  limit?: number | undefined;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface DiscoveryResult {
  query: string | null;
  entries: RegistryEntry[];
}

const PackageSchema = z
  .object({
    registryType: z.string().optional(),
    identifier: z.string().optional(),
    version: z.string().optional(),
    transport: z.object({ type: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

const RemoteSchema = z.object({ type: z.string().optional(), url: z.string().optional() }).passthrough();

const ServerDocSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional() }).passthrough().optional(),
    packages: z.array(PackageSchema).optional(),
    remotes: z.array(RemoteSchema).optional(),
  })
  .passthrough();

const ListSchema = z
  .object({
    servers: z.array(z.unknown()),
    metadata: z.object({ nextCursor: z.string().nullish() }).passthrough().optional(),
  })
  .passthrough();

function installLine(pkg: z.infer<typeof PackageSchema>): string | undefined {
  const id = pkg.identifier;
  if (id === undefined) return undefined;
  const version = pkg.version !== undefined && pkg.version !== 'latest' ? `@${pkg.version}` : '';
  switch (pkg.registryType) {
    case 'npm':
      return `npx -y ${id}${version}`;
    case 'pypi':
      return `uvx ${id}`;
    case 'oci':
    case 'docker':
      return `docker run -i --rm ${id}`;
    case 'nuget':
      return `dotnet tool run ${id}`;
    default:
      return `${pkg.registryType ?? 'package'}: ${id}`;
  }
}

export function normalizeEntry(item: unknown): RegistryEntry | undefined {
  const wrapper = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
  if (!wrapper) return undefined;
  const parsed = ServerDocSchema.safeParse('server' in wrapper ? wrapper['server'] : wrapper);
  if (!parsed.success) return undefined;
  const doc = parsed.data;
  const transports = new Set<string>();
  const install: string[] = [];
  for (const pkg of doc.packages ?? []) {
    const line = installLine(pkg);
    if (line) install.push(line);
    if (pkg.transport?.type) transports.add(pkg.transport.type);
  }
  for (const remote of doc.remotes ?? []) {
    if (remote.type) transports.add(remote.type);
    if (remote.url) install.push(`${remote.type ?? 'remote'}: ${remote.url}`);
  }
  return {
    name: doc.name,
    title: doc.title ?? null,
    description: doc.description ?? '',
    version: doc.version ?? 'inconnue',
    publisher: doc.name.includes('/') ? (doc.name.split('/')[0] ?? doc.name) : doc.name,
    transports: [...transports],
    install,
    repository: doc.repository?.url ?? null,
    documentation: doc.websiteUrl ?? doc.repository?.url ?? null,
  };
}

async function fetchPage(search: string | undefined, limit: number, options: DiscoveryOptions): Promise<RegistryEntry[]> {
  const url = new URL('/v0.1/servers', options.baseUrl ?? REGISTRY_BASE_URL);
  url.searchParams.set('limit', String(limit));
  if (search !== undefined) url.searchParams.set('search', search);
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new McpTerminalError(
      'DISCOVERY_FAILED',
      `Registre MCP injoignable : ${error instanceof Error ? error.message : String(error)}`,
      'Vérifiez votre connexion Internet.',
    );
  }
  if (!response.ok) {
    throw new McpTerminalError('DISCOVERY_FAILED', `Le registre MCP a répondu HTTP ${response.status}.`);
  }
  const parsed = ListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new McpTerminalError('DISCOVERY_FAILED', 'Réponse du registre MCP au format inattendu.');
  }
  return parsed.data.servers.flatMap((item) => {
    const entry = normalizeEntry(item);
    return entry ? [entry] : [];
  });
}

/** Interroge l'API officielle du registre ; `term` peut être une catégorie (voir CATEGORY_QUERIES) ou du texte libre. */
export async function discover(term: string | undefined, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const limit = options.limit ?? 20;
  const key = term?.toLowerCase();
  const queries: Array<string | undefined> =
    key !== undefined && CATEGORY_QUERIES[key] !== undefined ? [...(CATEGORY_QUERIES[key] ?? [])] : [term];
  const perQuery = Math.max(1, Math.ceil(limit / queries.length));
  const seen = new Map<string, RegistryEntry>();
  for (const query of queries) {
    for (const entry of await fetchPage(query, perQuery, options)) {
      if (!seen.has(entry.name)) seen.set(entry.name, entry);
    }
  }
  return { query: term ?? null, entries: [...seen.values()].slice(0, limit) };
}

export function renderRegistry(entries: readonly RegistryEntry[], style: Style): string {
  if (entries.length === 0) return 'Aucun serveur trouvé dans le registre.';
  return entries
    .map((entry) =>
      [
        style.bold(style.cyan(entry.name)) + style.dim(`  v${entry.version}`),
        `  ${entry.description || '(pas de description)'}`,
        `  Publisher     : ${entry.publisher}`,
        `  Transport     : ${entry.transports.length > 0 ? entry.transports.join(', ') : 'non précisé'}`,
        `  Installation  : ${entry.install.length > 0 ? entry.install.join('  |  ') : 'voir la documentation'}`,
        `  Repository    : ${entry.repository ?? '—'}`,
        `  Documentation : ${entry.documentation ?? '—'}`,
      ].join('\n'),
    )
    .join('\n\n');
}
