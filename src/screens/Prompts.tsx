import { useState } from 'react';
import { getPrompt } from '../lib/mcp';
import type { PromptInfo, Session } from '../lib/mcp';

interface Arg { name: string; description?: string; required?: boolean }

export function PromptsScreen({ session, prompts, loading, onRefresh, onError }: {
  session: Session | null;
  prompts: PromptInfo[];
  loading: boolean;
  onRefresh: () => void;
  onError: (error: unknown) => void;
}) {
  const [selected, setSelected] = useState<PromptInfo | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<Array<{ role: string; text: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return <p className="muted">Connectez-vous d'abord à un serveur.</p>;

  if (selected) {
    const args = ((selected as { arguments?: Arg[] }).arguments ?? []) as Arg[];
    const run = async (): Promise<void> => {
      setBusy(true);
      try {
        const out = await getPrompt(session, selected.name, values);
        setOutput(out.messages.map((m) => {
          const content = (m as { content?: { type?: string; text?: string } }).content;
          return { role: String((m as { role?: string }).role ?? '?'), text: content?.type === 'text' ? String(content.text ?? '') : JSON.stringify(content) };
        }));
      } catch (e) { onError(e); } finally { setBusy(false); }
    };
    return (
      <section>
        <button className="btn ghost small" onClick={() => { setSelected(null); setOutput(null); setValues({}); }}>← Prompts</button>
        <h2 className="mono">{selected.name}</h2>
        <p className="muted">{(selected as { description?: string }).description ?? ''}</p>
        <div className="form">
          {args.map((a) => (
            <div className="field" key={a.name}>
              <label>{a.name} {a.required && <span className="req">requis</span>}</label>
              <input className="input" value={values[a.name] ?? ''} onChange={(e) => setValues({ ...values, [a.name]: e.target.value })} />
              {a.description && <p className="hint">{a.description}</p>}
            </div>
          ))}
          <button className="btn primary block" disabled={busy} onClick={() => void run()}>{busy ? 'En cours…' : 'Obtenir le prompt'}</button>
        </div>
        {output?.map((m, i) => <div className="card" key={i}><div className="badge">{m.role}</div><pre className="pre">{m.text}</pre></div>)}
      </section>
    );
  }

  return (
    <section>
      <div className="row between"><h2>Prompts</h2><button className="btn small" onClick={onRefresh}>↻</button></div>
      {loading && <p className="muted">Chargement…</p>}
      {!loading && prompts.length === 0 && <p className="muted">Ce serveur n'expose aucun prompt.</p>}
      {prompts.map((p) => (
        <button className="card item" key={p.name} onClick={() => setSelected(p)}>
          <strong className="mono">{p.name}</strong>
          <span className="muted clamp">{(p as { description?: string }).description ?? ''}</span>
        </button>
      ))}
    </section>
  );
}
