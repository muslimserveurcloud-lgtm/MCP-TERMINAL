import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createDemoServer } from '../examples/demo-factory.js';
import { McpClientManager } from '../src/mcpClient.js';
import type { ResolvedHttp, ResolvedStdio } from '../src/types.js';

const demoServerPath = fileURLToPath(new URL('../examples/demo-server.js', import.meta.url));

const stdioDemo: ResolvedStdio = {
  name: 'demo',
  transport: 'stdio',
  command: process.execPath,
  args: [demoServerPath],
  env: {},
  timeoutMs: 20_000,
  negotiate: true,
};

function firstText(result: { content: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const block = content[0] as { type?: string; text?: string } | undefined;
  return block?.type === 'text' ? (block.text ?? '') : '';
}

describe('McpClientManager (stdio, serveur de démonstration)', () => {
  const manager = new McpClientManager();
  afterEach(async () => {
    await manager.disconnectAll();
  });

  it('connecte, expose infos/capabilities et liste les tools', async () => {
    const summary = await manager.connect(stdioDemo);
    assert.equal(summary.name, 'demo');
    assert.ok(summary.capabilities !== null);
    assert.ok(manager.isConnected('demo'));
    const names = (await manager.listTools('demo')).map((tool) => tool.name).sort();
    assert.deepEqual(names, ['calculate', 'hello']);
  });

  it('appelle un tool et gère les erreurs du tool', async () => {
    await manager.connect(stdioDemo);
    const hello = await manager.callTool('demo', 'hello', { name: 'Awa' });
    assert.equal(firstText(hello), 'Bonjour Awa !');
    const sum = await manager.callTool('demo', 'calculate', { operation: 'add', a: 2, b: 3 });
    assert.equal(firstText(sum), '5');
    const division = await manager.callTool('demo', 'calculate', { operation: 'divide', a: 1, b: 0 });
    assert.equal(division.isError, true);
  });

  it('signale clairement un tool inconnu en listant les tools disponibles', async () => {
    await manager.connect(stdioDemo);
    await assert.rejects(manager.getTool('demo', 'inexistant'), (error: unknown) => {
      const e = error as { code?: string; hint?: string };
      return e.code === 'TOOL_NOT_FOUND' && (e.hint ?? '').includes('hello') && (e.hint ?? '').includes('calculate');
    });
  });

  it('lit les resources et récupère les prompts', async () => {
    await manager.connect(stdioDemo);
    const resources = await manager.listResources('demo');
    assert.ok(resources.some((r) => r.uri === 'demo://about'));
    const read = await manager.readResource('demo', 'demo://about');
    assert.equal(read.contents.length, 1);
    const prompts = await manager.listPrompts('demo');
    assert.ok(prompts.some((p) => p.name === 'resume'));
    const prompt = await manager.getPrompt('demo', 'resume', { sujet: 'MCP' });
    assert.equal(prompt.messages.length, 1);
  });

  it('teste une connexion puis la referme', async () => {
    const report = await manager.test(stdioDemo);
    assert.equal(report.ok, true);
    assert.equal(report.counts.tools, 2);
    assert.equal(manager.isConnected('demo'), false);
  });

  it('se déconnecte proprement et refuse ensuite les appels', async () => {
    await manager.connect(stdioDemo);
    assert.equal(await manager.disconnect('demo'), true);
    assert.equal(await manager.disconnect('demo'), false);
    await assert.rejects(manager.listTools('demo'), { code: 'NOT_CONNECTED' });
  });

  it('retourne CONNECTION_FAILED pour une commande introuvable', async () => {
    await assert.rejects(
      manager.connect({ ...stdioDemo, name: 'ko', command: 'commande-qui-n-existe-pas-xyz', args: [], timeoutMs: 5_000 }),
      { code: 'CONNECTION_FAILED' },
    );
    assert.equal(manager.isConnected('ko'), false);
  });
});

describe('McpClientManager (Streamable HTTP en mémoire, sans réseau)', () => {
  it('connecte via un fetch en mémoire et appelle un tool', async () => {
    const handler = createMcpHandler(createDemoServer);
    const manager = new McpClientManager({ fetch: (url, init) => handler.fetch(new Request(url, init)) });
    const server: ResolvedHttp = {
      name: 'http-demo',
      transport: 'streamable-http',
      url: 'http://test.local/mcp',
      headers: {},
      timeoutMs: 20_000,
      negotiate: true,
    };
    try {
      await manager.connect(server);
      const names = (await manager.listTools('http-demo')).map((tool) => tool.name).sort();
      assert.deepEqual(names, ['calculate', 'hello']);
      const result = await manager.callTool('http-demo', 'hello', { name: 'HTTP' });
      assert.equal(firstText(result), 'Bonjour HTTP !');
    } finally {
      await manager.disconnectAll();
      await handler.close();
    }
  });

  it('ne révèle pas les secrets des en-têtes dans les erreurs de connexion', async () => {
    const { registerSecret, clearSecrets } = await import('../src/logger.js');
    registerSecret('jeton-ultra-secret-99');
    const manager = new McpClientManager({
      fetch: () => Promise.reject(new Error('refusé pour Bearer jeton-ultra-secret-99')),
    });
    try {
      await assert.rejects(
        manager.connect({
          name: 'ko-http',
          transport: 'streamable-http',
          url: 'http://test.local/mcp',
          headers: { Authorization: 'Bearer jeton-ultra-secret-99' },
          timeoutMs: 5_000,
          negotiate: false,
        }),
        (error: unknown) => {
          const e = error as { code?: string; message: string; hint?: string };
          return (e.code === 'CONNECTION_FAILED' || e.code === 'TIMEOUT') && !e.message.includes('jeton-ultra-secret-99');
        },
      );
    } finally {
      clearSecrets();
    }
  });
});
