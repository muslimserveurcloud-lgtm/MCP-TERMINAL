import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createDemoServer } from './demo-factory.js';

// stdout est le canal JSON-RPC : tout message de diagnostic doit aller sur stderr.
const handle = serveStdio(createDemoServer);
console.error('demo-server : en attente d\'un client MCP sur stdio (Ctrl+C pour arrêter)');

process.on('SIGINT', () => {
  void handle.close().finally(() => process.exit(0));
});
