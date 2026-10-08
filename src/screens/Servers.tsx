import { useEffect, useState } from 'react';
import { headersToLines, parseHeaderLines, validateHeaders } from '../lib/secrets';
import { newId } from '../lib/storage';
import type { Secrets, ServerEntry } from '../lib/storage';
import { Journal } from '../components/Journal';
import type { TestReport } from '../lib/mcp';

interface Props {
  servers: ServerEntry[];
  activeId: string | null;
  busy: boolean;
  secrets: Secrets;
  draft: Partial<ServerEntry> | null;
  onSave: (servers: ServerEntry[]) => Promise<void>;
  onConnect: (server: ServerEntry) => void;
  onDisconnect: () => void;
  onTest: (server: ServerEntry) => Promise<TestReport>;
  onNotify: (message: string, kind?: 'ok' | 'error') => void;
  onDraftConsumed: () => void;
}

export function ServersScreen({ servers, activeId, busy, secrets, draft, onSave, onConnect, onDisconnect, onTest, onNotify, onDraftConsumed }: Props) {
  const [editing, setEditing] = useState<ServerEntry | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ id: string; text: string } | null>(null);

  // Un brouillon venant de l'onglet Découvrir pré-remplit le formulaire.
  useEffect(() => {
    if (!draft) return;
    setEditing(null);
    setName(draft.name ?? '');
    setUrl(draft.url ?? '');
    setHeaders('');
    setError(null);
    setOpen(true);
    onDraftConsumed();
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (server: ServerEntry | null): void => {
    setEditing(server);
    setName(server?.name ?? '');
    setUrl(server?.url ?? '');
    setHeaders(server ? headersToLines(server.headers) : '');
    setError(null);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    try {
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Le nom est requis.');
      let parsed: URL;
      try { parsed = new URL(url.trim().replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'x')); } catch { throw new Error('URL invalide.'); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Seuls http:// et https:// sont acceptés.');
      if (parsed.username || parsed.password) throw new Error("Les identifiants dans l'URL sont interdits : utilisez un en-tête Authorization.");
      if (/[?&][^=&]*(token|key|secret|passw(or)?d)[^=&]*=(?!\$\{)[^&]+/i.test(url)) throw new Error("L'URL contient un secret en clair : utilisez ${NOM} (Coffre).");
      const parsedHeaders = parseHeaderLines(headers);
      const headerError = validateHeaders(parsedHeaders);
      if (headerError) throw new Error(headerError);
      if (servers.some((s) => s.name === trimmedName && s.id !== editing?.id)) throw new Error('Ce nom existe déjà.');
      const entry: ServerEntry = { id: editing?.id ?? newId(), name: trimmedName, url: url.trim(), headers: parsedHeaders };
      await onSave(editing ? servers.map((s) => (s.id === editing.id ? entry : s)) : [...servers, entry]);
      if (parsed.protocol === 'http:') onNotify('Connexion non chiffrée (http://) : préférez https:// hors réseau local.', 'error');
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (server: ServerEntry): Promise<void> => {
    if (!window.confirm(`Supprimer le serveur « ${server.name} » ?`)) return;
    if (activeId === server.id) onDisconnect();
    await onSave(servers.filter((s) => s.id !== server.id));
  };

  const test = async (server: ServerEntry): Promise<void> => {
    try {
      const r = await onTest(server);
      const info = (r.info ?? {}) as { name?: string; version?: string };
      setReport({
        id: server.id,
        text: `✔ ${info.name ?? 'serveur'} ${info.version ?? ''} · connexion ${r.connectMs} ms · ping ${r.pingMs === null ? 'n/d' : `${r.pingMs} ms`} · tools ${r.tools ?? '?'} · resources ${r.resources ?? '?'} · prompts ${r.prompts ?? '?'}`,
      });
    } catch (e) {
      onNotify(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <section>
      <div className="row between">
        <h2>Serveurs MCP</h2>
        <button className="btn primary" onClick={() => startEdit(null)}>+ Ajouter</button>
      </div>

      {open && (
        <div className="card form">
          <h3>{editing ? 'Modifier le serveur' : 'Nouveau serveur'}</h3>
          <div className="field"><label>Nom</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" autoCapitalize="off" /></div>
          <div className="field"><label>URL (Streamable HTTP)</label><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://exemple.com/mcp" inputMode="url" autoCapitalize="off" autoCorrect="off" /></div>
          <div className="field">
            <label>En-têtes (un par ligne)</label>
            <textarea className="input mono" rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={'Authorization: Bearer ${GITHUB_TOKEN}'} spellCheck={false} />
            <p className="hint">Les secrets s'écrivent <code>{'${NOM}'}</code> et se créent dans l'onglet Coffre : leur valeur n'est jamais stockée ici.</p>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="btn primary" onClick={() => void save()}>Enregistrer</button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Annuler</button>
          </div>
        </div>
      )}

      {servers.length === 0 && !open && <p className="muted">Aucun serveur. Ajoutez-en un, ou cherchez dans l'onglet Découvrir.</p>}

      {servers.map((server) => (
        <div className="card" key={server.id}>
          <div className="row between">
            <strong>{server.name}</strong>
            {activeId === server.id && <span className="badge ok">connecté</span>}
          </div>
          <div className="mono dim wrap">{server.url}</div>
          {Object.keys(server.headers).length > 0 && (
            <div className="mono dim wrap">{Object.entries(server.headers).map(([k, v]) => `${k}: ${/\$\{/.test(v) ? v : '***'}`).join(' · ')}</div>
          )}
          {report?.id === server.id && <p className="ok-text">{report.text}</p>}
          <div className="row wrap">
            {activeId === server.id
              ? <button className="btn" onClick={onDisconnect}>Déconnecter</button>
              : <button className="btn primary" disabled={busy} onClick={() => onConnect(server)}>{busy ? '…' : 'Connecter'}</button>}
            <button className="btn" disabled={busy} onClick={() => void test(server)}>Tester</button>
            <button className="btn ghost" onClick={() => startEdit(server)}>Modifier</button>
            <button className="btn danger" onClick={() => void remove(server)}>Supprimer</button>
          </div>
        </div>
      ))}

      <Journal secrets={secrets} />
    </section>
  );
}
