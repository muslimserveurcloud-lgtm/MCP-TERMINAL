import { useCallback, useEffect, useState } from 'react';
import { describeError, log } from './lib/http';
import { closeSession, connectServer, listPrompts, listResources, listTools, testServer } from './lib/mcp';
import type { PromptInfo, ResourceInfo, Session, ToolInfo } from './lib/mcp';
import { redact } from './lib/secrets';
import { loadSecrets, loadServers, saveSecrets, saveServers } from './lib/storage';
import type { Secrets, ServerEntry } from './lib/storage';
import { DiscoverScreen } from './screens/Discover';
import { PromptsScreen } from './screens/Prompts';
import { ResourcesScreen } from './screens/Resources';
import { ServersScreen } from './screens/Servers';
import { ToolsScreen } from './screens/Tools';
import { VaultScreen } from './screens/Vault';

type Tab = 'servers' | 'tools' | 'resources' | 'prompts' | 'discover' | 'vault';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'servers', label: 'Serveurs', icon: '🖥️' },
  { id: 'tools', label: 'Tools', icon: '🛠️' },
  { id: 'resources', label: 'Resources', icon: '📄' },
  { id: 'prompts', label: 'Prompts', icon: '💬' },
  { id: 'discover', label: 'Découvrir', icon: '🔎' },
  { id: 'vault', label: 'Coffre', icon: '🔑' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('servers');
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [draft, setDraft] = useState<Partial<ServerEntry> | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [resources, setResources] = useState<ResourceInfo[]>([]);
  const [prompts, setPrompts] = useState<PromptInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const notify = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ text, kind });
    // Les erreurs restent affichées jusqu'à un appui (pour avoir le temps de faire une capture).
    if (kind === 'ok') window.setTimeout(() => setToast(null), 4000);
  }, []);

  /** Toute erreur affichée est purgée des secrets du Coffre. */
  const fail = useCallback((error: unknown) => {
    const text = redact(describeError(error), secrets);
    log(`✖ ${text}`);
    notify(text.length > 500 ? `${text.slice(0, 500)}…` : text, 'error');
  }, [notify, secrets]);

  useEffect(() => {
    void (async () => {
      setServers(await loadServers());
      setSecrets(await loadSecrets());
    })();
  }, []);

  const refresh = useCallback(async (s: Session | null) => {
    if (!s) { setTools([]); setResources([]); setPrompts([]); return; }
    setLoading(true);
    const safe = async <T,>(fn: () => Promise<T[]>): Promise<T[]> => { try { return await fn(); } catch { return []; } };
    const [t, r, p] = await Promise.all([safe(() => listTools(s)), safe(() => listResources(s)), safe(() => listPrompts(s))]);
    setTools(t); setResources(r); setPrompts(p);
    setLoading(false);
  }, []);

  const connect = async (server: ServerEntry): Promise<void> => {
    setBusy(true);
    try {
      if (session) await closeSession(session);
      const next = await connectServer(server, secrets);
      setSession(next);
      await refresh(next);
      notify(`Connecté à « ${server.name} »`);
      setTab('tools');
    } catch (e) {
      setSession(null);
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = (): void => {
    if (session) void closeSession(session);
    setSession(null);
    void refresh(null);
  };

  const saveServerList = async (next: ServerEntry[]): Promise<void> => { setServers(next); await saveServers(next); };
  const saveSecretList = async (next: Secrets): Promise<void> => { setSecrets(next); await saveSecrets(next); };

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="title">MUSLIM MCP TERMINAL</div>
          <div className="sub">{session ? `● ${session.server.name}` : '○ non connecté'}</div>
        </div>
      </header>

      {toast && <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>{toast.text}</div>}

      <main className="content">
        {tab === 'servers' && (
          <ServersScreen
            servers={servers}
            activeId={session?.server.id ?? null}
            busy={busy}
            secrets={secrets}
            draft={draft}
            onDraftConsumed={() => setDraft(null)}
            onSave={saveServerList}
            onConnect={(s) => void connect(s)}
            onDisconnect={disconnect}
            onTest={(s) => testServer(s, secrets)}
            onNotify={notify}
          />
        )}
        {tab === 'tools' && <ToolsScreen session={session} tools={tools} loading={loading} onRefresh={() => void refresh(session)} onError={fail} />}
        {tab === 'resources' && <ResourcesScreen session={session} resources={resources} loading={loading} onRefresh={() => void refresh(session)} onError={fail} />}
        {tab === 'prompts' && <PromptsScreen session={session} prompts={prompts} loading={loading} onRefresh={() => void refresh(session)} onError={fail} />}
        {tab === 'discover' && <DiscoverScreen onError={fail} onUse={(d) => { setDraft(d); setTab('servers'); }} />}
        {tab === 'vault' && <VaultScreen secrets={secrets} onSave={saveSecretList} />}
      </main>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
            <span className="icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
