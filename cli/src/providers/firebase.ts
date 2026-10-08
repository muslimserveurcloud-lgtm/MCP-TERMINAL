import { McpTerminalError } from '../errors.js';
import { runProviderTool } from './common.js';
import type { ProviderBackend, ProviderRun } from './common.js';

export function listCollections(backend: ProviderBackend, extra?: Record<string, unknown>): Promise<ProviderRun> {
  return runProviderTool(backend, {
    capability: 'lister les collections Firestore',
    candidates: ['firestore_list_collections', 'list_collections', /list[-_]?collections?/i],
    wishes: [],
    ...(extra !== undefined ? { extra } : {}),
  });
}

export function getDocument(
  backend: ProviderBackend,
  collection: string,
  document: string,
  extra?: Record<string, unknown>,
): Promise<ProviderRun> {
  const path = `${collection}/${document}`;
  return runProviderTool(backend, {
    capability: 'lire un document Firestore',
    candidates: ['firestore_get_documents', 'firestore_get_document', 'get_document', /(get|read)[-_]?documents?/i],
    wishes: [
      { aliases: ['collection', 'collection_path', 'collectionPath', 'collectionName'], value: collection },
      { aliases: ['document', 'document_id', 'documentId', 'doc', 'id'], value: document },
      { aliases: ['path', 'document_path', 'documentPath'], value: path },
      { aliases: ['paths'], value: [path] },
    ],
    ...(extra !== undefined ? { extra } : {}),
  });
}

export function addDocument(
  backend: ProviderBackend,
  collection: string,
  rawJson: string,
  extra?: Record<string, unknown>,
): Promise<ProviderRun> {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch {
    throw new McpTerminalError('INVALID_ARGUMENT', 'Le document à ajouter n\'est pas un JSON valide.');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new McpTerminalError('INVALID_ARGUMENT', 'Le document doit être un objet JSON.');
  }
  return runProviderTool(backend, {
    capability: 'ajouter un document Firestore',
    candidates: ['firestore_add_document', 'add_document', 'create_document', 'firestore_create_document', /(add|create)[-_]?document/i],
    wishes: [
      { aliases: ['collection', 'collection_path', 'collectionPath', 'collectionName'], value: collection },
      { aliases: ['data', 'document', 'fields', 'content', 'value'], value: data },
    ],
    ...(extra !== undefined ? { extra } : {}),
  });
}
