import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SENSITIVE_KEY_PATTERN } from './types.js';

const secrets = new Set<string>();

/** Enregistre une valeur à masquer partout (logs, erreurs, sorties). */
export function registerSecret(value: string | undefined): void {
  if (value !== undefined && value.length >= 4) secrets.add(value);
}

export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) registerSecret(value);
  }
}

export function clearSecrets(): void {
  secrets.clear();
}

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***'],
  [
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g,
    '***',
  ],
  [/([?&](?:access_)?(?:token|key|api_key|apikey|secret|password)=)[^&\s"']+/gi, '$1***'],
];

export function redact(text: string): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***');
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

function parseLevel(raw: string | undefined): LogLevel {
  return raw !== undefined && raw in LEVELS ? (raw as LogLevel) : 'warn';
}

let currentLevel: LogLevel = parseLevel(process.env['MCP_TERMINAL_LOG_LEVEL']);

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: Exclude<LogLevel, 'silent'>, message: string): void {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  const line = redact(`[${level}] ${message}`);
  process.stderr.write(line + '\n');
  const file = process.env['MCP_TERMINAL_LOG_FILE'];
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      /* le logging ne doit jamais faire échouer l'application */
    }
  }
}

export const logger = {
  error: (message: string): void => emit('error', message),
  warn: (message: string): void => emit('warn', message),
  info: (message: string): void => emit('info', message),
  debug: (message: string): void => emit('debug', message),
};
