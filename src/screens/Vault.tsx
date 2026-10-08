import { useState } from 'react';
import { cleanSecret } from '../lib/secrets';
import type { Secrets } from '../lib/storage';

export function VaultScreen({ secrets, onSave }: { secrets: Secrets; onSave: (secrets: Secrets) => Promise<void> }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    const key = name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return setError('Nom invalide : lettres, chiffres et _ (ex. GITHUB_TOKEN).');
    const clean = cleanSecret(value);
    if (!clean) return setError('La valeur est vide.');
    await onSave({ ...secrets, [key]: clean });
    setName(''); setValue(''); setError(null);
  };

  const remove = async (key: string): Promise<void> => {
    if (!window.confirm(`Supprimer le secret ${key} ?`)) return;
    const next = { ...secrets };
    delete next[key];
    await onSave(next);
  };

  return (
    <section>
      <h2>Coffre à secrets</h2>
      <p className="muted">Clés et jetons utilisés par vos serveurs via <code>{'${NOM}'}</code>. Ils restent dans le stockage privé de l'application, ne sont jamais affichés et sont masqués dans les messages d'erreur.</p>
      <div className="card form">
        <div className="field"><label>Nom</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="GITHUB_TOKEN" autoCapitalize="characters" autoCorrect="off" /></div>
        <div className="field"><label>Valeur</label><input className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></div>
        {error && <p className="error">{error}</p>}
        <button className="btn primary" onClick={() => void add()}>Enregistrer le secret</button>
      </div>
      {Object.keys(secrets).length === 0 && <p className="muted">Aucun secret enregistré.</p>}
      {Object.keys(secrets).sort().map((key) => (
        <div className="card row between" key={key}>
          <div><strong className="mono">{key}</strong><div className="dim mono">{secrets[key]?.slice(0, 4)}••••  ({secrets[key]?.length ?? 0} car.)</div></div>
          <button className="btn danger" onClick={() => void remove(key)}>Supprimer</button>
        </div>
      ))}
    </section>
  );
}
