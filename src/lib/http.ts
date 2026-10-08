import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { FetchLike } from '@modelcontextprotocol/client';

/* ------------------------------------------------------------------ journal */

const MAX_ENTRIES = 200;
const entries: string[] = [];

/** Journal de diagnostic (jamais d'en-têtes ni de corps de requête ; masqué des secrets à l'affichage). */
export function log(text: string): void {
  entries.push(`${new Date().toLocaleTimeString('fr-FR')} ${text}`);
  if (entries.length > MAX_ENTRIES) entries.shift();
}
export const getLog = (): string[] => [...entries];
export const clearLog = (): void => { entries.length = 0; };

export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    if (current instanceof Error) {
      const extra = current as Error & { code?: unknown; status?: unknown };
      const code = extra.code !== undefined ? ` [code ${String(extra.code)}]` : '';
      const status = extra.status !== undefined ? ` [HTTP ${String(extra.status)}]` : '';
      parts.push(`${current.name}: ${current.message}${code}${status}`);
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join(' ← ');
}

/* -------------------------------------------------------------------- fetch */

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

function where(url: string): string {
  try { const u = new URL(url); return `${u.host}${u.pathname}`; } catch { return url; }
}

/**
 * fetch compatible SDK MCP qui passe par la pile HTTP native d'Android (CapacitorHttp) : pas de CORS.
 * La réponse est reçue en entier (pas de flux) ; le flux SSE optionnel « serveur → client » (GET) est refusé
 * avec 405, ce que la spécification Streamable HTTP autorise.
 */
export const nativeFetch: FetchLike = async (input, init) => {
  const url = typeof input === 'string' ? input : input.toString();
  const method = (init?.method ?? 'GET').toUpperCase();
  const requestHeaders = new Headers(init?.headers);

  if (method === 'GET' && (requestHeaders.get('accept') ?? '').includes('text/event-stream')) {
    log(`GET ${where(url)} : flux SSE non supporté sur mobile → 405`);
    return new Response(null, { status: 405 });
  }
  if (!Capacitor.isNativePlatform()) return window.fetch(input, init);

  const headers: Record<string, string> = {};
  requestHeaders.forEach((value, key) => { headers[key] = value; });
  let data: unknown = typeof init?.body === 'string' ? init.body : undefined;
  if (typeof data === 'string' && (headers['content-type'] ?? '').includes('application/json')) {
    try { data = JSON.parse(data); } catch { /* on garde le texte */ }
  }

  // Méthode JSON-RPC de la requête (initialize, tools/call…) pour le diagnostic ; jamais le contenu.
  let rpc = '';
  if (typeof init?.body === 'string') {
    try {
      const parsed: unknown = JSON.parse(init.body);
      rpc = Array.isArray(parsed) ? 'lot' : String((parsed as { method?: unknown }).method ?? 'réponse');
    } catch { /* corps non JSON */ }
  }
  const handshake = /^(initialize|server\/)/.test(rpc);
  log(`→ ${method} ${where(url)} ${rpc}`.trimEnd());
  try {
    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
      responseType: 'text',
      connectTimeout: 20_000,
      readTimeout: 90_000,
    });
    const text = typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data);
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers ?? {})) {
      try { responseHeaders.set(key, String(value)); } catch { /* en-tête invalide ignoré */ }
    }
    log(`← ${res.status} ${responseHeaders.get('content-type') ?? ''} (${text.length} car.)${res.status >= 400 || handshake ? ` ${text.slice(0, 160).replace(/\s+/g, ' ')}` : ''}`);
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : text, { status: res.status, headers: responseHeaders });
  } catch (error) {
    log(`✖ ${method} ${where(url)} : ${describeError(error)}`);
    throw error;
  }
};
