import { McpTerminalError } from '../errors.js';
import { parseRepo, runProviderTool } from './common.js';
import type { ProviderBackend, ProviderRun } from './common.js';

const OWNER = ['owner', 'user', 'username', 'org', 'organization'] as const;
const REPO = ['repo', 'repository', 'repo_name', 'name'] as const;

export interface ListReposOptions {
  owner?: string;
  query?: string;
  extra?: Record<string, unknown>;
}

/** Liste les dépôts via le premier tool de type « list/search repositories » réellement exposé. */
export function listRepos(backend: ProviderBackend, options: ListReposOptions = {}): Promise<ProviderRun> {
  const query = options.query ?? (options.owner !== undefined ? `user:${options.owner}` : undefined);
  return runProviderTool(backend, {
    capability: 'lister les dépôts GitHub',
    candidates: ['list_repositories', 'list_repos', 'search_repositories', /^(list|search)[-_]?(my[-_]?)?repo/i],
    wishes: [
      { aliases: OWNER, value: options.owner },
      { aliases: ['query', 'q', 'search'], value: query },
    ],
    ...(options.extra !== undefined ? { extra: options.extra } : {}),
  });
}

export function getIssue(
  backend: ProviderBackend,
  repoRef: string,
  issueNumber: string,
  extra?: Record<string, unknown>,
): Promise<ProviderRun> {
  const { owner, repo } = parseRepo(repoRef);
  const number = Number.parseInt(issueNumber, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new McpTerminalError('INVALID_ARGUMENT', `Numéro d'issue invalide : "${issueNumber}".`);
  }
  return runProviderTool(backend, {
    capability: 'lire une issue GitHub',
    candidates: ['get_issue', 'issue_read', /^(get|read)[-_]?issue$/i, /issue.*read|read.*issue/i],
    wishes: [
      { aliases: ['owner'], value: owner },
      { aliases: REPO, value: repo },
      { aliases: ['issue_number', 'issueNumber', 'number', 'issue'], value: number },
      // Certains serveurs regroupent plusieurs opérations dans un seul tool via un paramètre "method".
      { aliases: ['method'], value: 'get' },
    ],
    ...(extra !== undefined ? { extra } : {}),
  });
}

export interface CreatePrOptions {
  head?: string;
  base?: string;
  body?: string;
  draft?: boolean;
  extra?: Record<string, unknown>;
}

export function createPullRequest(
  backend: ProviderBackend,
  repoRef: string,
  title: string,
  options: CreatePrOptions = {},
): Promise<ProviderRun> {
  const { owner, repo } = parseRepo(repoRef);
  if (title.trim() === '') throw new McpTerminalError('INVALID_ARGUMENT', 'Le titre de la pull request est vide.');
  return runProviderTool(backend, {
    capability: 'créer une pull request GitHub',
    candidates: ['create_pull_request', /^create[-_]?(pull[-_]?request|pr)$/i],
    wishes: [
      { aliases: ['owner'], value: owner },
      { aliases: REPO, value: repo },
      { aliases: ['title'], value: title },
      { aliases: ['head', 'head_branch', 'source_branch'], value: options.head },
      { aliases: ['base', 'base_branch', 'target_branch'], value: options.base },
      { aliases: ['body', 'description'], value: options.body },
      { aliases: ['draft'], value: options.draft === true ? true : undefined },
    ],
    ...(options.extra !== undefined ? { extra: options.extra } : {}),
  });
}
