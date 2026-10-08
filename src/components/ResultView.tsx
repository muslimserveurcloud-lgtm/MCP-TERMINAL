import { useState } from 'react';

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

function Block({ block }: { block: unknown }) {
  const b = asObj(block);
  if (!b) return <pre className="pre">{String(block)}</pre>;
  const type = b['type'];
  if (type === 'text') return <pre className="pre">{String(b['text'] ?? '')}</pre>;
  if (type === 'image') return <img className="img" alt="résultat" src={`data:${String(b['mimeType'] ?? 'image/png')};base64,${String(b['data'] ?? '')}`} />;
  if (type === 'audio') return <audio controls src={`data:${String(b['mimeType'] ?? 'audio/mpeg')};base64,${String(b['data'] ?? '')}`} />;
  if (type === 'resource') {
    const r = asObj(b['resource']) ?? {};
    return <div><div className="mono dim">{String(r['uri'] ?? '')}</div><pre className="pre">{typeof r['text'] === 'string' ? r['text'] : '[contenu binaire]'}</pre></div>;
  }
  if (type === 'resource_link') return <div className="mono dim">{String(b['uri'] ?? '')}</div>;
  return <pre className="pre">{JSON.stringify(b, null, 2)}</pre>;
}

/** Affiche le résultat d'un appel de tool (texte, image, audio, ressources, contenu structuré). */
export function ResultView({ result }: { result: unknown }) {
  const [showRaw, setShowRaw] = useState(false);
  const r = asObj(result) ?? {};
  const content = Array.isArray(r['content']) ? (r['content'] as unknown[]) : [];
  return (
    <div className="result">
      {r['isError'] === true && <p className="error">Le serveur a signalé une erreur pour cet appel.</p>}
      {content.map((block, index) => <Block key={index} block={block} />)}
      {r['structuredContent'] !== undefined && (
        <details><summary>Contenu structuré</summary><pre className="pre">{JSON.stringify(r['structuredContent'], null, 2)}</pre></details>
      )}
      <button className="btn ghost small" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Masquer' : 'Voir'} le JSON brut</button>
      {showRaw && <pre className="pre">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
