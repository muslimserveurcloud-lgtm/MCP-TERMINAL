import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { redact } from './logger.js';

export type ErrorCode =
  | 'SERVER_NOT_FOUND'
  | 'SERVER_EXISTS'
  | 'NOT_CONNECTED'
  | 'INVALID_CONFIG'
  | 'INVALID_ARGUMENT'
  | 'INVALID_URL'
  | 'SECRET_LITERAL'
  | 'MISSING_ENV'
  | 'CONNECTION_FAILED'
  | 'TIMEOUT'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_ERROR'
  | 'MCP_ERROR'
  | 'DISCOVERY_FAILED'
  | 'CONFIRMATION_REQUIRED'
  | 'CANCELLED'
  | 'UNKNOWN_COMMAND'
  | 'INTERNAL';

/** Erreur applicative : message et indice sont toujours purgés des secrets connus. */
export class McpTerminalError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(redact(message));
    this.name = 'McpTerminalError';
    this.code = code;
    this.hint = hint === undefined ? undefined : redact(hint);
  }
}

export function toTerminalError(error: unknown): McpTerminalError {
  if (error instanceof McpTerminalError) return error;
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) {
      return new McpTerminalError('TIMEOUT', `Délai dépassé : ${error.message}`);
    }
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected) {
      return new McpTerminalError(
        'CONNECTION_FAILED',
        `Connexion fermée : ${error.message}`,
        'Reconnectez-vous avec /servers connect <nom>.',
      );
    }
    return new McpTerminalError('MCP_ERROR', error.message);
  }
  if (error instanceof ProtocolError) {
    return new McpTerminalError('MCP_ERROR', `Erreur MCP (${String(error.code)}) : ${error.message}`);
  }
  if (error instanceof Error) return new McpTerminalError('INTERNAL', error.message);
  return new McpTerminalError('INTERNAL', String(error));
}
