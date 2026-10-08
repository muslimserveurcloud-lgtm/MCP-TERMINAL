import * as z from 'zod/v4';

export const APP_NAME = 'muslim-mcp-terminal';
export const APP_VERSION = '1.0.0';
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Noms de clés / en-têtes / options dont la valeur doit être un secret référencé (${VAR}). */
export const SENSITIVE_KEY_PATTERN =
  /(token|secret|passw(or)?d|api[_-]?key|authorization|credential|cookie|private[_-]?key|service[_-]?account)/i;

export const ServerNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    'Nom de serveur invalide (lettres, chiffres, "_", ".", "-" ; 64 caractères max)',
  );

const StringMapSchema = z.record(z.string(), z.string());
const TimeoutSchema = z.number().int().positive().max(3_600_000);
const NegotiationSchema = z.enum(['auto', 'default']);

export const StdioServerSchema = z.object({
  name: ServerNameSchema,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: StringMapSchema.optional(),
  cwd: z.string().min(1).optional(),
  timeoutMs: TimeoutSchema.optional(),
  protocolNegotiation: NegotiationSchema.optional(),
});

export const StreamableHttpServerSchema = z.object({
  name: ServerNameSchema,
  transport: z.literal('streamable-http'),
  url: z.string().min(1),
  headers: StringMapSchema.optional(),
  timeoutMs: TimeoutSchema.optional(),
  protocolNegotiation: NegotiationSchema.optional(),
});

export const SseServerSchema = z.object({
  name: ServerNameSchema,
  transport: z.literal('sse'),
  url: z.string().min(1),
  headers: StringMapSchema.optional(),
  timeoutMs: TimeoutSchema.optional(),
  protocolNegotiation: NegotiationSchema.optional(),
});

export const ServerConfigSchema = z.discriminatedUnion('transport', [
  StdioServerSchema,
  StreamableHttpServerSchema,
  SseServerSchema,
]);

export const ConfigFileSchema = z.object({
  defaultServer: ServerNameSchema.optional(),
  servers: z.record(z.string(), ServerConfigSchema).default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** Configuration dont les références ${VAR} ont été résolues (jamais écrite sur disque). */
export interface ResolvedStdio {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  negotiate: boolean;
}

export interface ResolvedHttp {
  name: string;
  transport: 'streamable-http' | 'sse';
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  negotiate: boolean;
}

export type ResolvedServer = ResolvedStdio | ResolvedHttp;

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  color: boolean;
}

export interface Io {
  /** Demande une confirmation. Lève CONFIRMATION_REQUIRED en mode non interactif sans --yes. */
  confirm(question: string): Promise<boolean>;
}
