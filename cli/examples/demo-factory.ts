import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

/** Fabrique du serveur de démonstration (réutilisée par le point d'entrée stdio et par les tests). */
export function createDemoServer(): McpServer {
  const server = new McpServer({ name: 'muslim-demo-server', version: '1.0.0' });

  server.registerTool(
    'hello',
    {
      description: 'Salue une personne',
      inputSchema: z.object({ name: z.string().describe('Nom à saluer') }),
      outputSchema: z.object({ greeting: z.string() }),
    },
    async ({ name }) => {
      const greeting = `Bonjour ${name} !`;
      return { content: [{ type: 'text', text: greeting }], structuredContent: { greeting } };
    },
  );

  server.registerTool(
    'calculate',
    {
      description: 'Effectue une opération arithmétique simple',
      inputSchema: z.object({
        operation: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('Opération à effectuer'),
        a: z.number().describe('Premier opérande'),
        b: z.number().describe('Second opérande'),
      }),
      outputSchema: z.object({ result: z.number() }),
    },
    async ({ operation, a, b }) => {
      if (operation === 'divide' && b === 0) {
        return { content: [{ type: 'text', text: 'Division par zéro impossible' }], isError: true };
      }
      const result =
        operation === 'add' ? a + b : operation === 'subtract' ? a - b : operation === 'multiply' ? a * b : a / b;
      return { content: [{ type: 'text', text: String(result) }], structuredContent: { result } };
    },
  );

  server.registerResource(
    'about',
    'demo://about',
    { title: 'À propos', description: 'Description du serveur de démonstration', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, text: 'Serveur MCP de démonstration de MUSLIM MCP TERMINAL.' }] }),
  );

  server.registerPrompt(
    'resume',
    { description: 'Demande un résumé sur un sujet', argsSchema: z.object({ sujet: z.string() }) },
    ({ sujet }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Résume le sujet suivant : ${sujet}` } }],
    }),
  );

  return server;
}
