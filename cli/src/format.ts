import { McpTerminalError } from './errors.js';
import { redact } from './logger.js';
import type { ToolCallResult, ToolInfo } from './mcpClient.js';
import type { OutputOptions } from './types.js';

/* ------------------------------------------------------------------ couleurs */

export function createStyle(color: boolean) {
  const wrap = (code: string) => (text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    magenta: wrap('35'),
  };
}
export type Style = ReturnType<typeof createStyle>;

export function colorSupported(): boolean {
  return process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';
}

/* ------------------------------------------------------------------- sortie */

export interface Sink {
  out(text: string): void;
  err(text: string): void;
}

const processSink: Sink = {
  out: (text) => void process.stdout.write(`${text}\n`),
  err: (text) => void process.stderr.write(`${text}\n`),
};

/** Toute sortie passe par `redact` : aucun secret connu ne peut atteindre le terminal. */
export class Output {
  constructor(
    readonly opts: OutputOptions,
    private readonly sink: Sink = processSink,
  ) {}

  get json(): boolean {
    return this.opts.json;
  }

  get style(): Style {
    return createStyle(this.opts.color && !this.opts.json);
  }

  /** Résultat de commande : JSON en mode --json, rendu lisible sinon. Jamais supprimé par --quiet. */
  data(payload: unknown, render: () => string): void {
    this.sink.out(redact(this.opts.json ? JSON.stringify(payload, null, 2) : render()));
  }

  /** Message d'information (masqué par --quiet et --json). */
  info(text: string): void {
    if (!this.opts.json && !this.opts.quiet) this.sink.out(redact(text));
  }

  warn(text: string): void {
    if (!this.opts.quiet) this.sink.err(redact(this.style.yellow(`⚠ ${text}`)));
  }

  error(error: McpTerminalError): void {
    if (this.opts.json) {
      const payload: Record<string, unknown> = { error: true, code: error.code, message: error.message };
      if (error.hint !== undefined) payload['hint'] = error.hint;
      this.sink.out(redact(JSON.stringify(payload, null, 2)));
      return;
    }
    const { style } = this;
    this.sink.err(redact(`${style.red(style.bold(`Erreur [${error.code}]`))} ${error.message}`));
    if (error.hint !== undefined) this.sink.err(redact(style.dim(`→ ${error.hint}`)));
  }
}

/* ------------------------------------------------------------------ helpers */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function title(style: Style, text: string): string {
  return `${style.bold(text)}\n${'─'.repeat(Math.max(28, text.length))}`;
}

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[], style: Style): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [style.bold(line(headers)), ...rows.map(line)].join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/* ------------------------------------------------------------ schémas d'outils */

function schemaType(schema: Record<string, unknown>): string {
  const type = schema['type'];
  if (typeof type === 'string') {
    if (type === 'array') {
      const items = asRecord(schema['items']);
      return `array<${items ? schemaType(items) : 'any'}>`;
    }
    return type;
  }
  if (Array.isArray(type)) return type.map(String).join(' | ');
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      return variants
        .map((variant) => {
          const record = asRecord(variant);
          return record ? schemaType(record) : 'any';
        })
        .join(' | ');
    }
  }
  return 'enum' in schema ? 'enum' : 'any';
}

function schemaConstraints(schema: Record<string, unknown>): string[] {
  const constraints: string[] = [];
  const show = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value));
  if (Array.isArray(schema['enum'])) constraints.push(`valeurs : ${schema['enum'].map(show).join(' | ')}`);
  if ('const' in schema) constraints.push(`constante : ${show(schema['const'])}`);
  if ('default' in schema) constraints.push(`défaut : ${show(schema['default'])}`);
  const numeric: Array<[string, string]> = [
    ['minimum', 'min'],
    ['maximum', 'max'],
    ['exclusiveMinimum', 'min exclusif'],
    ['exclusiveMaximum', 'max exclusif'],
    ['minLength', 'longueur min'],
    ['maxLength', 'longueur max'],
    ['minItems', 'éléments min'],
    ['maxItems', 'éléments max'],
    ['pattern', 'motif'],
    ['format', 'format'],
  ];
  for (const [key, label] of numeric) {
    if (key in schema) constraints.push(`${label} : ${show(schema[key])}`);
  }
  return constraints;
}

function renderProperties(
  properties: Record<string, unknown>,
  required: ReadonlySet<string>,
  indent: string,
  style: Style,
  depth: number,
): string[] {
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const schema = asRecord(raw) ?? {};
    const flag = required.has(name) ? style.red('requis') : style.dim('optionnel');
    lines.push(`${indent}${style.cyan(name)} (${schemaType(schema)}) — ${flag}`);
    const description = schema['description'];
    if (typeof description === 'string' && description !== '') lines.push(`${indent}  ${description}`);
    const constraints = schemaConstraints(schema);
    if (constraints.length > 0) lines.push(style.dim(`${indent}  ${constraints.join(' ; ')}`));
    const nested = asRecord(schema['properties']);
    if (nested && depth < 3) {
      const nestedRequired = new Set(
        Array.isArray(schema['required']) ? schema['required'].filter((v): v is string => typeof v === 'string') : [],
      );
      lines.push(...renderProperties(nested, nestedRequired, `${indent}    `, style, depth + 1));
    }
  }
  return lines;
}

export function renderToolDescription(tool: ToolInfo, style: Style): string {
  const record = asRecord(tool) ?? {};
  const lines: string[] = [style.bold(tool.name)];
  const heading = record['title'];
  if (typeof heading === 'string' && heading !== '') lines.push(`Titre : ${heading}`);
  const description = record['description'];
  lines.push(`Description : ${typeof description === 'string' && description !== '' ? description : '(aucune)'}`);
  const schema = asRecord(record['inputSchema']) ?? {};
  lines.push('', style.bold('Input schema'), `  type : ${schemaType(schema)}`);
  const properties = asRecord(schema['properties']) ?? {};
  const required = new Set(
    Array.isArray(schema['required']) ? schema['required'].filter((v): v is string => typeof v === 'string') : [],
  );
  if (Object.keys(properties).length === 0) lines.push('  (aucune propriété)');
  else lines.push('  propriétés :', ...renderProperties(properties, required, '    ', style, 0));
  if (required.size > 0) lines.push(`  requis : ${[...required].join(', ')}`);
  if (schema['additionalProperties'] === false) lines.push('  propriétés supplémentaires : interdites');
  const annotations = asRecord(record['annotations']);
  if (annotations && Object.keys(annotations).length > 0) lines.push('', `Annotations : ${JSON.stringify(annotations)}`);
  if (record['outputSchema'] !== undefined) lines.push('', 'Output schema :', JSON.stringify(record['outputSchema'], null, 2));
  return lines.join('\n');
}

/* ------------------------------------------------------- résultat d'un appel */

export function renderContentBlock(block: unknown, style: Style): string {
  const record = asRecord(block);
  if (!record) return String(block);
  const type = record['type'];
  if (type === 'text' && typeof record['text'] === 'string') return record['text'];
  if (type === 'image' || type === 'audio') {
    const data = typeof record['data'] === 'string' ? record['data'] : '';
    const size = formatBytes(Math.floor((data.length * 3) / 4));
    return style.dim(`[${String(type)} ${String(record['mimeType'] ?? 'inconnu')} · ${size} en base64 — utilisez --json pour le contenu]`);
  }
  if (type === 'resource') {
    const resource = asRecord(record['resource']) ?? {};
    const text = typeof resource['text'] === 'string' ? resource['text'] : style.dim('[contenu binaire]');
    return `${style.cyan(String(resource['uri'] ?? 'resource'))}\n${text}`;
  }
  if (type === 'resource_link') {
    return `${style.cyan(String(record['uri'] ?? ''))} ${record['name'] !== undefined ? `(${String(record['name'])})` : ''}`.trim();
  }
  return JSON.stringify(record, null, 2);
}

export function renderToolResult(result: ToolCallResult, style: Style): string {
  const lines: string[] = [];
  if (result.isError === true) lines.push(style.red('Le serveur a signalé une erreur pour cet appel :'));
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  for (const block of content) lines.push(renderContentBlock(block, style));
  if (result.structuredContent !== undefined) {
    lines.push('', style.dim('structuredContent :'), JSON.stringify(result.structuredContent, null, 2));
  }
  return lines.length > 0 ? lines.join('\n') : style.dim('(résultat vide)');
}
