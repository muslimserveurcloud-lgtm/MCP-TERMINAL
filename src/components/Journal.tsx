import { useEffect, useState } from 'react';
import { clearLog, getLog } from '../lib/http';
import { redact } from '../lib/secrets';
import type { Secrets } from '../lib/storage';

/** Journal de diagnostic : aide à comprendre un échec de connexion (secrets masqués, aucun en-tête journalisé). */
export function Journal({ secrets }: { secrets: Secrets }) {
  const [lines, setLines] = useState<string[]>(getLog());

  useEffect(() => {
    const id = window.setInterval(() => setLines(getLog()), 800);
    return () => window.clearInterval(id);
  }, []);

  const text = redact(lines.join('\n'), secrets);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      window.alert('Journal copié dans le presse-papiers.');
    } catch {
      window.alert('Copie impossible : sélectionnez le texte à la main.');
    }
  };

  return (
    <details className="card" open={lines.length > 0}>
      <summary>Journal de diagnostic ({lines.length})</summary>
      <pre className="pre journal">{text || 'Vide. Appuyez sur Connecter ou Tester pour le remplir.'}</pre>
      <div className="row">
        <button className="btn small" onClick={() => void copy()}>Copier</button>
        <button className="btn small ghost" onClick={() => { clearLog(); setLines([]); }}>Effacer</button>
      </div>
    </details>
  );
}
