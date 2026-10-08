import { nativeFetch } from './http';

const BASE = 'https://registry.modelcontextprotocol.io';

/** Mots-clés de recherche (pas une liste de serveurs) : le registre officiel est interrogé en direct. */
export const CATEGORIES: Record<string, string[]> = {
  github: ['github'],
  firebase: ['firebase'],
  elevenlabs: ['elevenlabs'],
  database: ['database', 'postgres', 'sqlite', 'mysql', 'mongodb'],
  ai: ['ai', 'llm', 'openai'],
  media: ['media', 'video', 'audio', 'image'],
};

export interface RegistryItem {
  name: string;
  description: string;
  version: string;
  publisher: string;
  remotes: Array<{ type: string; url: string }>;
  installs: string[];
  repository: string | null;
}

const asObj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function normalize(item: unknown): RegistryItem | undefined {
  const wrapper = asObj(item);
  const doc = asObj(wrapper?.['server']) ?? wrapper;
  const name = str(doc?.['name']);
  if (!doc || !name) return undefined;
  const remotes = (Array.isArray(doc['remotes']) ? doc['remotes'] : []).flatMap((r) => {
    const o = asObj(r);
    const url = str(o?.['url']);
    return url ? [{ type: str(o?.['type']) ?? 'inconnu', url }] : [];
  });
  const installs = (Array.isArray(doc['packages']) ? doc['packages'] : []).flatMap((p) => {
    const o = asObj(p);
    const id = str(o?.['identifier']);
    return id ? [`${str(o?.['registryType']) ?? 'package'} : ${id}`] : [];
  });
  return {
    name,
    description: str(doc['description']) ?? '',
    version: str(doc['version']) ?? '?',
    publisher: name.includes('/') ? (name.split('/')[0] ?? name) : name,
    remotes,
    installs,
    repository: str(asObj(doc['repository'])?.['url']) ?? null,
  };
}

async function page(search: string | undefined, limit: number): Promise<RegistryItem[]> {
  const url = new URL('/v0.1/servers', BASE);
  url.searchParams.set('limit', String(limit));
  if (search) url.searchParams.set('search', search);
  const response = await nativeFetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Le registre MCP a répondu HTTP ${response.status}.`);
  const json = asObj(await response.json());
  const servers = Array.isArray(json?.['servers']) ? json['servers'] : [];
  return servers.flatMap((s) => { const n = normalize(s); return n ? [n] : []; });
}

export async function searchRegistry(term: string, limit = 20): Promise<RegistryItem[]> {
  const text = term.trim();
  const list: Array<string | undefined> = CATEGORIES[text.toLowerCase()] ?? (text ? [text] : [undefined]);
  const per = Math.max(1, Math.ceil(limit / list.length));
  const seen = new Map<string, RegistryItem>();
  for (const q of list) for (const item of await page(q, per)) if (!seen.has(item.name)) seen.set(item.name, item);
  return [...seen.values()].slice(0, limit);
}
