import { useState } from 'react';
import { readResource } from '../lib/mcp';
import type { ResourceInfo, Session } from '../lib/mcp';

export function ResourcesScreen({ session, resources, loading, onRefresh, onError }: {
  session: Session | null;
  resources: ResourceInfo[];
  loading: boolean;
  onRefresh: () => void;
  onError: (error: unknown) => void;
}) {
  const [content, setContent] = useState<{ uri: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!session) return <p className="muted">Connectez-vous d'abord à un serveur.</p>;

  const open = async (uri: string): Promise<void> => {
    setBusy(true);
    try {
      const out = await readResource(session, uri);
      const text = out.contents
        .map((c) => {
          const item = c as { text?: string; blob?: string; mimeType?: string };
          return typeof item.text === 'string' ? item.text : `[contenu binaire ${item.mimeType ?? ''} · ${Math.round(((item.blob ?? '').length * 3) / 4 / 1024)} Ko]`;
        })
        .join('\n\n');
      setContent({ uri, text });
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  if (content) {
    return (
      <section>
        <button className="btn ghost small" onClick={() => setContent(null)}>← Resources</button>
        <h3 className="mono wrap">{content.uri}</h3>
        <pre className="pre">{content.text}</pre>
      </section>
    );
  }

  return (
    <section>
      <div className="row between"><h2>Resources</h2><button className="btn small" onClick={onRefresh}>↻</button></div>
      {loading && <p className="muted">Chargement…</p>}
      {!loading && resources.length === 0 && <p className="muted">Ce serveur n'expose aucune resource.</p>}
      {resources.map((r) => (
        <button className="card item" key={r.uri} disabled={busy} onClick={() => void open(r.uri)}>
          <strong>{(r as { name?: string }).name ?? r.uri}</strong>
          <span className="mono dim wrap">{r.uri}</span>
        </button>
      ))}
    </section>
  );
}
