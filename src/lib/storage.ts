import { Preferences } from '@capacitor/preferences';

/** Seul Streamable HTTP est supporté sur mobile (pas de processus stdio ni de flux SSE long sur Android). */
export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  /** Valeurs pouvant contenir des références ${SECRET} résolues depuis le Coffre. */
  headers: Record<string, string>;
}

export type Secrets = Record<string, string>;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const { value } = await Preferences.get({ key });
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(value) });
}

export const loadServers = (): Promise<ServerEntry[]> => readJson<ServerEntry[]>('mcp.servers', []);
export const saveServers = (servers: ServerEntry[]): Promise<void> => writeJson('mcp.servers', servers);
export const loadSecrets = (): Promise<Secrets> => readJson<Secrets>('mcp.secrets', {});
export const saveSecrets = (secrets: Secrets): Promise<void> => writeJson('mcp.secrets', secrets);

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
