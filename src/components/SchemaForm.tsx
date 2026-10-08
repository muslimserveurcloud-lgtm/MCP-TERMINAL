import { useMemo, useState } from 'react';

type Json = Record<string, unknown>;

interface Prop { name: string; schema: Json; required: boolean }

const asObj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

function propsOf(inputSchema: unknown): Prop[] {
  const schema = asObj(inputSchema) ?? {};
  const properties = asObj(schema['properties']) ?? {};
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as unknown[]).map(String) : []);
  return Object.entries(properties).map(([name, raw]) => ({ name, schema: asObj(raw) ?? {}, required: required.has(name) }));
}

function kindOf(schema: Json): 'enum' | 'boolean' | 'number' | 'integer' | 'string' | 'json' {
  if (Array.isArray(schema['enum'])) return 'enum';
  const type = Array.isArray(schema['type']) ? (schema['type'] as unknown[]).find((t) => t !== 'null') : schema['type'];
  if (type === 'boolean') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'integer') return 'integer';
  if (type === 'string') return 'string';
  return 'json';
}

function constraints(schema: Json): string {
  const parts: string[] = [];
  for (const [key, label] of [['minimum', 'min'], ['maximum', 'max'], ['minLength', 'longueur min'], ['maxLength', 'longueur max'], ['pattern', 'motif'], ['format', 'format']] as const) {
    if (schema[key] !== undefined) parts.push(`${label} ${String(schema[key])}`);
  }
  if (schema['default'] !== undefined) parts.push(`défaut ${JSON.stringify(schema['default'])}`);
  return parts.join(' · ');
}

export function SchemaForm({ inputSchema, busy, submitLabel, onSubmit }: {
  inputSchema: unknown;
  busy: boolean;
  submitLabel: string;
  onSubmit: (args: Record<string, unknown>) => void;
}) {
  const props = useMemo(() => propsOf(inputSchema), [inputSchema]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [raw, setRaw] = useState('{}');
  const [rawMode, setRawMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    setError(null);
    if (rawMode) {
      try {
        const parsed: unknown = JSON.parse(raw);
        const obj = asObj(parsed);
        if (!obj) throw new Error('Un objet JSON est attendu.');
        onSubmit(obj);
      } catch (e) {
        setError(`JSON invalide : ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    const args: Record<string, unknown> = {};
    for (const { name, schema, required } of props) {
      const value = values[name];
      const kind = kindOf(schema);
      if (kind === 'boolean') {
        if (value === true || required) args[name] = value === true;
        continue;
      }
      if (value === undefined || value === '') {
        if (required) return setError(`« ${name} » est requis.`);
        continue;
      }
      try {
        if (kind === 'number' || kind === 'integer') {
          const n = Number(value);
          if (Number.isNaN(n)) throw new Error('nombre invalide');
          args[name] = kind === 'integer' ? Math.trunc(n) : n;
        } else if (kind === 'json') {
          args[name] = JSON.parse(String(value));
        } else if (kind === 'enum') {
          const options = schema['enum'] as unknown[];
          args[name] = options.find((o) => String(o) === value) ?? value;
        } else {
          args[name] = value;
        }
      } catch (e) {
        return setError(`« ${name} » : ${e instanceof Error ? e.message : 'valeur invalide'}`);
      }
    }
    onSubmit(args);
  };

  return (
    <div className="form">
      <label className="switch">
        <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} />
        <span>Mode JSON brut</span>
      </label>

      {rawMode ? (
        <textarea className="input mono" rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
      ) : props.length === 0 ? (
        <p className="muted">Ce tool n'a aucun paramètre.</p>
      ) : (
        props.map(({ name, schema, required }) => {
          const kind = kindOf(schema);
          const description = typeof schema['description'] === 'string' ? schema['description'] : '';
          const hint = constraints(schema);
          const common = { id: `f-${name}`, className: 'input' } as const;
          return (
            <div className="field" key={name}>
              <label htmlFor={`f-${name}`}>
                {name} {required && <span className="req">requis</span>} <span className="type">{kind}</span>
              </label>
              {kind === 'enum' ? (
                <select {...common} value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })}>
                  <option value="">—</option>
                  {(schema['enum'] as unknown[]).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                </select>
              ) : kind === 'boolean' ? (
                <label className="switch"><input type="checkbox" checked={values[name] === true} onChange={(e) => setValues({ ...values, [name]: e.target.checked })} /><span>activé</span></label>
              ) : kind === 'number' || kind === 'integer' ? (
                <input {...common} type="number" inputMode="decimal" value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
              ) : kind === 'json' ? (
                <textarea {...common} className="input mono" rows={3} placeholder="JSON (objet, tableau…)" value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })} spellCheck={false} />
              ) : /(content|text|body|prompt|query|message|description)/i.test(name) ? (
                <textarea {...common} rows={3} value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
              ) : (
                <input {...common} type="text" autoCapitalize="off" autoCorrect="off" value={String(values[name] ?? '')} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
              )}
              {description && <p className="hint">{description}</p>}
              {hint && <p className="hint dim">{hint}</p>}
            </div>
          );
        })
      )}

      {error && <p className="error">{error}</p>}
      <button className="btn primary block" disabled={busy} onClick={submit}>{busy ? 'En cours…' : submitLabel}</button>
    </div>
  );
}
