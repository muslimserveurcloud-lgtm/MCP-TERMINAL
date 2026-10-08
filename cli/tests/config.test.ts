import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ConfigStore,
  assertNoLiteralSecrets,
  expandEnv,
  parseDotEnv,
  resolveServer,
  tokenize,
  validateUrl,
} from '../src/config.js';
import { McpTerminalError } from '../src/errors.js';
import { clearSecrets, redact } from '../src/logger.js';
import type { ServerConfig } from '../src/types.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof McpTerminalError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('variables d\'environnement et secrets', () => {
  beforeEach(() => clearSecrets());

  it('expandEnv remplace ${VAR} et échoue proprement si absente', () => {
    assert.equal(expandEnv('Bearer ${MY_TOKEN}', { MY_TOKEN: 'abc12345' }), 'Bearer abc12345');
    assert.equal(codeOf(() => expandEnv('${ABSENTE}', {})), 'MISSING_ENV');
  });

  it('les valeurs sensibles résolues sont masquées dans redact()', () => {
    expandEnv('${GITHUB_TOKEN}', { GITHUB_TOKEN: 'supersecretvalue' });
    assert.equal(redact('échec avec supersecretvalue dans le message'), 'échec avec *** dans le message');
  });

  it('redact masque Bearer, jetons GitHub et paramètres de requête', () => {
    assert.equal(redact('Authorization: Bearer abcdef123456'), 'Authorization: Bearer ***');
    assert.ok(!redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('abcdefghij'));
    assert.equal(redact('https://x.io/mcp?token=hunter2&a=1'), 'https://x.io/mcp?token=***&a=1');
  });

  it('assertNoLiteralSecrets refuse les secrets en clair et accepte les références', () => {
    assert.equal(codeOf(() => assertNoLiteralSecrets('env', { GITHUB_TOKEN: 'ghp_clair' })), 'SECRET_LITERAL');
    assert.equal(codeOf(() => assertNoLiteralSecrets('header', { Authorization: 'Bearer clair' })), 'SECRET_LITERAL');
    assert.equal(codeOf(() => assertNoLiteralSecrets('env', { GITHUB_TOKEN: '${GITHUB_TOKEN}', DEBUG: '1' })), undefined);
  });

  it('parseDotEnv lit clés, guillemets et commentaires', () => {
    const parsed = parseDotEnv('# commentaire\nA=1\nexport B="deux mots"\nC=\'x\' \nD=val # fin');
    assert.deepEqual(parsed, { A: '1', B: 'deux mots', C: 'x', D: 'val' });
  });
});

describe('tokenize', () => {
  it('gère guillemets et échappements', () => {
    assert.deepEqual(tokenize(`npx -y "pkg avec espace" 'a b' c\\ d`), ['npx', '-y', 'pkg avec espace', 'a b', 'c d']);
  });

  it('conserve un JSON non quoté', () => {
    assert.deepEqual(tokenize('/tools call hello {"name":"Awa","n":[1,2]} --yes'), [
      '/tools',
      'call',
      'hello',
      '{"name":"Awa","n":[1,2]}',
      '--yes',
    ]);
  });

  it('refuse les opérateurs shell lorsque demandé', () => {
    assert.equal(codeOf(() => tokenize('npx pkg; rm -rf /', { rejectOperators: true })), 'INVALID_ARGUMENT');
    assert.equal(codeOf(() => tokenize('npx $(whoami)', { rejectOperators: true })), 'INVALID_ARGUMENT');
    assert.deepEqual(tokenize('npx "a;b"', { rejectOperators: true }), ['npx', 'a;b']);
  });

  it('refuse un guillemet non fermé', () => {
    assert.equal(codeOf(() => tokenize('echo "abc')), 'INVALID_ARGUMENT');
  });
});

describe('validateUrl', () => {
  it('accepte http(s) et avertit pour http distant', () => {
    assert.deepEqual(validateUrl('https://example.com/mcp').warnings, []);
    assert.equal(validateUrl('http://example.com/mcp').warnings.length, 1);
    assert.deepEqual(validateUrl('http://localhost:3000/mcp').warnings, []);
  });

  it('refuse protocoles exotiques, identifiants et secrets dans la requête', () => {
    assert.equal(codeOf(() => validateUrl('ftp://example.com')), 'INVALID_URL');
    assert.equal(codeOf(() => validateUrl('https://user:pw@example.com')), 'INVALID_URL');
    assert.equal(codeOf(() => validateUrl('pas une url')), 'INVALID_URL');
    assert.equal(codeOf(() => validateUrl('https://example.com/mcp?token=abc')), 'SECRET_LITERAL');
    assert.equal(codeOf(() => validateUrl('https://example.com/mcp?token=${MCP_AUTH_TOKEN}')), undefined);
  });
});

describe('ConfigStore', () => {
  let dir: string;
  let store: ConfigStore;
  const stdio: ServerConfig = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] };
  const http: ServerConfig = {
    name: 'gh',
    transport: 'streamable-http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcp-terminal-'));
    store = new ConfigStore(join(dir, 'servers.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('retourne une configuration vide si le fichier n\'existe pas', async () => {
    assert.deepEqual((await store.load()).servers, {});
  });

  it('ajoute, relit, refuse les doublons et supprime', async () => {
    await store.add(stdio);
    await store.add(http);
    assert.deepEqual(await store.names(), ['fs', 'gh']);
    await assert.rejects(store.add(stdio), { code: 'SERVER_EXISTS' });
    await store.add({ ...stdio, args: ['-y', 'autre'] }, true);
    assert.deepEqual(await store.get('fs'), { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'autre'] });
    await store.setDefault('gh');
    await store.remove('gh');
    assert.equal((await store.load()).defaultServer, undefined);
    await assert.rejects(store.get('gh'), { code: 'SERVER_NOT_FOUND' });
    await assert.rejects(store.remove('gh'), { code: 'SERVER_NOT_FOUND' });
  });

  it('écrit le fichier avec des permissions restreintes et sans valeur de secret', async () => {
    await store.add(http);
    const raw = await readFile(store.path, 'utf8');
    assert.ok(raw.includes('${GITHUB_TOKEN}'));
    if (process.platform !== 'win32') {
      assert.equal((await stat(store.path)).mode & 0o077, 0);
    }
  });

  it('rejette un fichier invalide avec INVALID_CONFIG', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(store.path, '{ pas du json');
    await assert.rejects(store.load(), { code: 'INVALID_CONFIG' });
    await writeFile(store.path, JSON.stringify({ servers: { a: { name: 'b', transport: 'stdio', command: 'x' } } }));
    await assert.rejects(store.load(), { code: 'INVALID_CONFIG' });
  });
});

describe('resolveServer', () => {
  beforeEach(() => clearSecrets());

  it('résout les références et masque les secrets ensuite', () => {
    const resolved = resolveServer(
      { name: 'gh', transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
      { GITHUB_TOKEN: 'valeur-secrete-123' },
    );
    const headers = 'headers' in resolved ? resolved.headers : {};
    assert.equal(headers['Authorization'], 'Bearer valeur-secrete-123');
    assert.ok(!redact(JSON.stringify(resolved)).includes('valeur-secrete-123'));
  });

  it('refuse un fichier édité à la main contenant un secret en clair', () => {
    assert.throws(
      () => resolveServer({ name: 'x', transport: 'stdio', command: 'node', args: [], env: { API_KEY: 'en-clair' } }, {}),
      { code: 'SECRET_LITERAL' },
    );
  });
});
