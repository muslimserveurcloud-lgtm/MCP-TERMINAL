import { useState } from 'react';
import { CATEGORIES, searchRegistry } from '../lib/registry';
import type { RegistryItem } from '../lib/registry';
import type { ServerEntry } from '../lib/storage';

export function DiscoverScreen({ onUse, onError }: { onUse: (draft: Partial<ServerEntry>) => void; onError: (error: unknown) => void }) {
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<RegistryItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async (value: string): Promise<void> => {
    setBusy(true);
    try { setItems(await searchRegistry(value)); } catch (e) { onError(e); } finally { setBusy(false); }
  };

  return (
    <section>
      <h2>Découvrir</h2>
      <p className="muted">Recherche en direct dans le registre officiel MCP. Sur mobile, seuls les serveurs <strong>distants Streamable HTTP</strong> sont utilisables.</p>
      <div className="row">
        <input className="input" placeholder="github, postgres, vidéo…" value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(term); }} />
        <button className="btn primary" disabled={busy} onClick={() => void search(term)}>OK</button>
      </div>
      <div className="chips">
        {Object.keys(CATEGORIES).map((c) => <button className="chip" key={c} onClick={() => { setTerm(c); void search(c); }}>{c}</button>)}
      </div>
      {busy && <p className="muted">Recherche…</p>}
      {items?.length === 0 && <p className="muted">Aucun résultat.</p>}
      {items?.map((item) => {
        const http = item.remotes.filter((r) => r.type === 'streamable-http');
        return (
          <div className="card" key={item.name}>
            <div className="row between"><strong className="wrap">{item.name}</strong><span className="badge">v{item.version}</span></div>
            <p className="muted">{item.description || '(pas de description)'}</p>
            {http.map((r) => (
              <div className="row between" key={r.url}>
                <span className="mono dim wrap">{r.url}</span>
                <button className="btn primary small" onClick={() => onUse({ name: item.name.split('/').pop() ?? item.name, url: r.url })}>Ajouter</button>
              </div>
            ))}
            {http.length === 0 && <p className="dim">{item.remotes.length > 0 ? 'Transport distant non supporté sur mobile.' : `Serveur local uniquement (${item.installs[0] ?? 'installation requise'}) : utilisez le terminal Termux.`}</p>}
            {item.repository && <p className="mono dim wrap">{item.repository}</p>}
          </div>
        );
      })}
    </section>
  );
}
