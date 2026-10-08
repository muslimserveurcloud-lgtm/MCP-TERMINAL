import { McpTerminalError } from '../errors.js';
import { asRecord } from '../format.js';
import type { ToolCallResult, ToolInfo } from '../mcpClient.js';

/** Accès minimal au serveur connecté : les raccourcis ne connaissent que ces deux opérations. */
export interface ProviderBackend {
  listTools(): Promise<ToolInfo[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/** Un paramètre « logique » du raccourci, avec les noms sous lesquels un tool peut le déclarer. */
export interface ArgWish {
  aliases: readonly string[];
  value: unknown;
}

export interface ProviderSpec {
  /** Libellé humain de la fonction recherchée (pour les messages d'erreur). */
  capability: string;
  /** Noms exacts ou motifs : le premier tool réellement exposé qui correspond est utilisé. */
  candidates: ReadonlyArray<string | RegExp>;
  wishes: readonly ArgWish[];
  /** Arguments fournis par l'utilisateur (--input-json) : prioritaires. */
  extra?: Record<string, unknown>;
}

export interface ProviderRun {
  tool: ToolInfo;
  arguments: Record<string, unknown>;
  result: ToolCallResult;
}

/** Cherche un tool parmi ceux RÉELLEMENT exposés ; sinon liste ce qui est disponible. */
export function findTool(tools: readonly ToolInfo[], candidates: ReadonlyArray<string | RegExp>, capability: string): ToolInfo {
  for (const candidate of candidates) {
    const match = tools.find((tool) => (typeof candidate === 'string' ? tool.name === candidate : candidate.test(tool.name)));
    if (match) return match;
  }
  throw new McpTerminalError(
    'TOOL_NOT_FOUND',
    `Le serveur connecté n'expose aucun tool correspondant à « ${capability} ».`,
    tools.length > 0
      ? `Tools réellement disponibles : ${tools.map((tool) => tool.name).join(', ')}. Utilisez /tools describe puis /tools call.`
      : "Ce serveur n'expose aucun tool.",
  );
}

/** Construit les arguments uniquement avec les paramètres que le schéma du tool déclare. */
export function buildArguments(
  tool: ToolInfo,
  wishes: readonly ArgWish[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const schema = asRecord(asRecord(tool)?.['inputSchema']) ?? {};
  const properties = new Set(Object.keys(asRecord(schema['properties']) ?? {}));
  const args: Record<string, unknown> = {};
  for (const wish of wishes) {
    if (wish.value === undefined) continue;
    const alias = wish.aliases.find((name) => properties.has(name));
    if (alias !== undefined) args[alias] = wish.value;
  }
  Object.assign(args, extra);
  const required = Array.isArray(schema['required']) ? schema['required'].filter((v): v is string => typeof v === 'string') : [];
  const missing = required.filter((name) => !(name in args));
  if (missing.length > 0) {
    throw new McpTerminalError(
      'INVALID_ARGUMENT',
      `Le tool "${tool.name}" exige des paramètres que ce raccourci ne sait pas renseigner : ${missing.join(', ')}.`,
      `Complétez avec --input-json '{"${missing[0] ?? 'param'}": ...}' ou consultez /tools describe ${tool.name}.`,
    );
  }
  return args;
}

export async function runProviderTool(backend: ProviderBackend, spec: ProviderSpec): Promise<ProviderRun> {
  const tools = await backend.listTools();
  const tool = findTool(tools, spec.candidates, spec.capability);
  const args = buildArguments(tool, spec.wishes, spec.extra ?? {});
  const result = await backend.callTool(tool.name, args);
  return { tool, arguments: args, result };
}

export function parseRepo(repo: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match) {
    throw new McpTerminalError('INVALID_ARGUMENT', `Dépôt invalide : "${repo}".`, 'Format attendu : propriétaire/dépôt (ex. octocat/hello-world).');
  }
  return { owner: match[1] ?? '', repo: match[2] ?? '' };
}
