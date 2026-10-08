import type { Secrets } from './storage';

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const SENSITIVE = /(token|secret|passw(or)?d|api[_-]?key|authorization|credential|cookie)/i;

export const hasRef = (value: string): boolean => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);

/** Nettoie une valeur collée : espaces, retours à la ligne et caractères invisibles en début/fin. */
export const cleanSecret = (value: string): string => value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

export function expandRefs(value: string, secrets: Secrets): string {
  return value.replace(REF, (_match, name: string) => {
    const secret = cleanSecret(secrets[name] ?? '');
    if (!secret) throw new Error(`Secret manquant : ${name}. Ajoutez-le dans l'onglet Coffre.`);
    return secret;
  });
}

/** Les en-têtes sensibles doivent référencer un secret du Coffre, jamais contenir la valeur en clair. */
export function validateHeaders(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return `Nom d'en-tête invalide : ${name}`;
    if (SENSITIVE.test(name) && value !== '' && !hasRef(value)) {
      return `L'en-tête « ${name} » doit référencer un secret, par exemple Bearer \${GITHUB_TOKEN} (créez-le dans le Coffre).`;
    }
  }
  return null;
}

export function parseHeaderLines(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.search(/[:=]/);
    if (index <= 0) throw new Error(`En-tête invalide : « ${line} » (format Nom: valeur)`);
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return headers;
}

export const headersToLines = (headers: Record<string, string>): string =>
  Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n');

export function redact(text: string, secrets: Secrets): string {
  let out = text;
  for (const value of Object.values(secrets).sort((a, b) => b.length - a.length)) {
    if (value.length >= 4) out = out.split(value).join('***');
  }
  return out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, '***');
}
