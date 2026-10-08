import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as z from 'zod/v4';
import { McpTerminalError } from './errors.js';
import { registerSecret } from './logger.js';
import {
  ConfigFileSchema,
  DEFAULT_TIMEOUT_MS,
  SENSITIVE_KEY_PATTERN,
  ServerConfigSchema,
} from './types.js';
import type { ConfigFile, ResolvedServer, ServerConfig } from './types.js';

/* ------------------------------------------------------------------ chemins */

export function getHomeDir(): string {
  return process.env['MCP_TERMINAL_HOME'] ?? join(homedir(), '.mcp-terminal');
}

export function getServersPath(): string {
  return join(getHomeDir(), 'servers.json');
}

export function getHistoryPath(): string {
  return join(getHomeDir(), 'history');
}

/* --------------------------------------------------------------- .env léger */

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    result[key] = value;
  }
  return result;
}

/** Charge ./.env puis ~/.mcp-terminal/.env sans écraser les variables déjà définies. */
export function loadDotEnvFiles(): void {
  for (const file of [join(process.cwd(), '.env'), join(getHomeDir(), '.env')]) {
    try {
      if (!existsSync(file)) continue;
      for (const [key, value] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) {
        if (process.env[key] === undefined && value !== '') process.env[key] = value;
      }
    } catch {
      /* fichier illisible : ignoré */
    }
  }
}

/* ------------------------------------------------------ variables d'environnement */

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function containsEnvRef(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

/** Remplace ${VAR} par la valeur de l'environnement. Les valeurs sensibles sont enregistrées pour le masquage. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_REF, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      throw new McpTerminalError(
        'MISSING_ENV',
        `Variable d'environnement manquante : ${name}`,
        `Définissez-la (export ${name}=...) ou ajoutez-la dans .env / ~/.mcp-terminal/.env.`,
      );
    }
    if (SENSITIVE_KEY_PATTERN.test(name)) registerSecret(resolved);
    return resolved;
  });
}

/** Refuse les secrets écrits en clair : seules les références ${VAR} sont autorisées. */
export function assertNoLiteralSecrets(kind: 'env' | 'header', map: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(map)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && value !== '' && !containsEnvRef(value)) {
      const example = kind === 'env' ? `${key}='\${${key}}'` : `${key}='Bearer \${NOM_VARIABLE}'`;
      throw new McpTerminalError(
        'SECRET_LITERAL',
        `La valeur de "${key}" ressemble à un secret et ne peut pas être enregistrée en clair.`,
        `Utilisez une référence à une variable d'environnement, par exemple : ${example}`,
      );
    }
  }
}

export function assertNoSecretArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    const match = /^--?([A-Za-z0-9_-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !SENSITIVE_KEY_PATTERN.test(match[1] ?? '')) continue;
    const inline = match[2];
    const next = args[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith('-') ? next : '');
    if (value !== '' && !containsEnvRef(value)) {
      throw new McpTerminalError(
        'SECRET_LITERAL',
        `L'argument "--${match[1] ?? ''}" semble contenir un secret en clair.`,
        "Passez le secret via --env NOM (référence ${NOM}) plutôt qu'en argument de ligne de commande.",
      );
    }
  }
}

/* --------------------------------------------------------------------- URLs */

export interface ValidatedUrl {
  url: string;
  warnings: string[];
}

export function validateUrl(raw: string): ValidatedUrl {
  const trimmed = raw.trim();
  const probe = trimmed.replace(ENV_REF, 'x');
  let parsed: URL;
  try {
    parsed = new URL(probe);
  } catch {
    throw new McpTerminalError('INVALID_URL', `URL invalide : ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpTerminalError('INVALID_URL', `Protocole non supporté (${parsed.protocol}) : seuls http: et https: sont acceptés.`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new McpTerminalError(
      'INVALID_URL',
      "Les identifiants dans l'URL sont interdits.",
      "Utilisez --header 'Authorization=Bearer ${NOM_VARIABLE}'.",
    );
  }
  if (/[?&][^=&]*(token|key|secret|passw(or)?d)[^=&]*=(?!\$\{)[^&]+/i.test(trimmed)) {
    throw new McpTerminalError(
      'SECRET_LITERAL',
      "L'URL contient un paramètre de requête ressemblant à un secret en clair.",
      'Utilisez une référence ${NOM_VARIABLE} ou un en-tête Authorization.',
    );
  }
  const warnings: string[] = [];
  const host = parsed.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (parsed.protocol === 'http:' && !local) {
    warnings.push('Connexion HTTP non chiffrée vers un hôte distant : préférez https://.');
  }
  return { url: trimmed, warnings };
}

/* ------------------------------------------------------------ tokenisation shell */

function findBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface TokenizeOptions {
  /** Refuse ; | & < > ` et $( ) hors guillemets (aucun shell n'est jamais utilisé, mais on évite les surprises). */
  rejectOperators?: boolean;
}

/**
 * Découpe une ligne façon shell (guillemets simples/doubles, échappements).
 * Un JSON ({...} ou [...]) non quoté en début de jeton est conservé tel quel.
 */
export function tokenize(line: string, options: TokenizeOptions = {}): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  const flush = (): void => {
    if (started) {
      tokens.push(current);
      current = '';
      started = false;
    }
  };
  while (i < line.length) {
    const ch = line.charAt(i);
    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }
    if (!started && (ch === '{' || ch === '[')) {
      const end = findBalanced(line, i);
      if (end > i) {
        current = line.slice(i, end + 1);
        started = true;
        i = end + 1;
        continue;
      }
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new McpTerminalError('INVALID_ARGUMENT', "Guillemet simple non fermé.");
      current += line.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      started = true;
      while (i < line.length && line.charAt(i) !== '"') {
        if (line.charAt(i) === '\\' && i + 1 < line.length) {
          current += line.charAt(i + 1);
          i += 2;
        } else {
          current += line.charAt(i);
          i += 1;
        }
      }
      if (i >= line.length) throw new McpTerminalError('INVALID_ARGUMENT', 'Guillemet double non fermé.');
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      current += line.charAt(i + 1);
      started = true;
      i += 2;
      continue;
    }
    if (options.rejectOperators === true) {
      if (/[;|&<>`]/.test(ch) || (ch === '$' && line.charAt(i + 1) === '(')) {
        throw new McpTerminalError(
          'INVALID_ARGUMENT',
          `Caractère de contrôle shell non autorisé dans la commande : "${ch}"`,
          'Aucun shell n\'est utilisé : fournissez directement le programme et ses arguments (entre guillemets si besoin).',
        );
      }
    }
    current += ch;
    started = true;
    i += 1;
  }
  flush();
  return tokens;
}

/* --------------------------------------------------------- résolution de serveur */

function mapValues(map: Readonly<Record<string, string>>, fn: (value: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[key] = fn(value);
  return out;
}

function envTimeout(): number | undefined {
  const raw = process.env['MCP_TERMINAL_TIMEOUT_MS'];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Résout les ${VAR} d'une configuration. Le résultat ne doit jamais être persisté. */
export function resolveServer(config: ServerConfig, env: NodeJS.ProcessEnv = process.env): ResolvedServer {
  const timeoutMs = config.timeoutMs ?? envTimeout() ?? DEFAULT_TIMEOUT_MS;
  const negotiate = (config.protocolNegotiation ?? 'auto') === 'auto';
  if (config.transport === 'stdio') {
    const rawEnv = config.env ?? {};
    assertNoLiteralSecrets('env', rawEnv);
    assertNoSecretArgs(config.args);
    return {
      name: config.name,
      transport: 'stdio',
      command: config.command,
      args: config.args.map((arg) => expandEnv(arg, env)),
      env: mapValues(rawEnv, (value) => expandEnv(value, env)),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      timeoutMs,
      negotiate,
    };
  }
  const rawHeaders = config.headers ?? {};
  assertNoLiteralSecrets('header', rawHeaders);
  validateUrl(config.url);
  return {
    name: config.name,
    transport: config.transport,
    url: expandEnv(config.url, env),
    headers: mapValues(rawHeaders, (value) => expandEnv(value, env)),
    timeoutMs,
    negotiate,
  };
}

/* --------------------------------------------------------------- persistance */

export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`).join(' ; ');
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

export class ConfigStore {
  constructor(private readonly filePath: string = getServersPath()) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<ConfigFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { servers: {} };
      throw new McpTerminalError('INVALID_CONFIG', `Lecture impossible de ${this.filePath}.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new McpTerminalError('INVALID_CONFIG', `${this.filePath} n'est pas un JSON valide.`);
    }
    const parsed = ConfigFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new McpTerminalError('INVALID_CONFIG', `Configuration invalide : ${formatZodIssues(parsed.error)}`);
    }
    for (const [key, server] of Object.entries(parsed.data.servers)) {
      if (key !== server.name) {
        throw new McpTerminalError('INVALID_CONFIG', `La clé "${key}" ne correspond pas au nom du serveur "${server.name}".`);
      }
    }
    return parsed.data;
  }

  async save(config: ConfigFile): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.filePath);
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      /* systèmes de fichiers sans permissions (ex. stockage partagé Android) */
    }
  }

  async names(): Promise<string[]> {
    return Object.keys((await this.load()).servers).sort();
  }

  async get(name: string): Promise<ServerConfig> {
    const config = await this.load();
    const server = config.servers[name];
    if (server === undefined) {
      const known = Object.keys(config.servers);
      throw new McpTerminalError(
        'SERVER_NOT_FOUND',
        `Serveur inconnu : "${name}".`,
        known.length > 0 ? `Serveurs configurés : ${known.join(', ')}.` : 'Aucun serveur configuré : utilisez /servers add.',
      );
    }
    return server;
  }

  async add(server: ServerConfig, overwrite = false): Promise<void> {
    const parsed = ServerConfigSchema.safeParse(server);
    if (!parsed.success) {
      throw new McpTerminalError('INVALID_CONFIG', `Configuration invalide : ${formatZodIssues(parsed.error)}`);
    }
    const config = await this.load();
    if (config.servers[parsed.data.name] !== undefined && !overwrite) {
      throw new McpTerminalError(
        'SERVER_EXISTS',
        `Le serveur "${parsed.data.name}" existe déjà.`,
        'Utilisez --force pour le remplacer ou /servers remove.',
      );
    }
    config.servers[parsed.data.name] = parsed.data;
    await this.save(config);
  }

  async remove(name: string): Promise<void> {
    const config = await this.load();
    if (config.servers[name] === undefined) await this.get(name);
    delete config.servers[name];
    if (config.defaultServer === name) delete config.defaultServer;
    await this.save(config);
  }

  async setDefault(name: string | undefined): Promise<void> {
    const config = await this.load();
    if (name === undefined) delete config.defaultServer;
    else {
      await this.get(name);
      config.defaultServer = name;
    }
    await this.save(config);
  }
}
