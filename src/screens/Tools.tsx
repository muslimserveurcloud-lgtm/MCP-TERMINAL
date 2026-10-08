import { useMemo, useState } from 'react';
import { ResultView } from '../components/ResultView';
import { SchemaForm } from '../components/SchemaForm';
import { callTool, isDestructive } from '../lib/mcp';
import type { Session, ToolInfo } from '../lib/mcp';

export function ToolsScreen({ session, tools, loading, onRefresh, onError }: {
  session: Session | null;
  tools: ToolInfo[];
  loading: boolean;
  onRefresh: () => void;
  onError: (error: unknown) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ToolInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);

  const filtered = useMemo(
    () => tools.filter((t) => `${t.name} ${(t as { description?: string }).description ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    [tools, query],
  );

  if (!session) return <p className="muted">Connectez-vous d'abord à un serveur (onglet Serveurs).</p>;

  if (selected) {
    const description = (selected as { description?: string }).description;
    const run = async (args: Record<string, unknown>): Promise<void> => {
      if (isDestructive(selected) && !window.confirm(`Le tool « ${selected.name} » peut être destructeur. Continuer ?`)) return;
      setBusy(true); setResult(null);
      try { setResult(await callTool(session, selected.name, args)); } catch (e) { onError(e); } finally { setBusy(false); }
    };
    return (
      <section>
        <button className="btn ghost small" onClick={() => { setSelected(null); setResult(null); }}>← Tous les tools</button>
        <h2 className="mono">{selected.name}</h2>
        {description && <p className="muted pre-wrap">{description}</p>}
        {isDestructive(selected) && <p className="warn">⚠ Ce tool semble destructeur : une confirmation sera demandée.</p>}
        <SchemaForm key={selected.name} inputSchema={selected.inputSchema} busy={busy} submitLabel="Appeler le tool" onSubmit={(args) => void run(args)} />
        {result !== null && <><h3>Résultat</h3><ResultView result={result} /></>}
      </section>
    );
  }

  return (
    <section>
      <div className="row between"><h2>Tools · {session.server.name}</h2><button className="btn small" onClick={onRefresh}>↻</button></div>
      <input className="input" placeholder="Rechercher…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading && <p className="muted">Chargement…</p>}
      {!loading && filtered.length === 0 && <p className="muted">Aucun tool.</p>}
      {filtered.map((tool) => (
        <button className="card item" key={tool.name} onClick={() => setSelected(tool)}>
          <strong className="mono">{tool.name}</strong>
          <span className="muted clamp">{(tool as { description?: string }).description ?? ''}</span>
        </button>
      ))}
    </section>
  );
}
