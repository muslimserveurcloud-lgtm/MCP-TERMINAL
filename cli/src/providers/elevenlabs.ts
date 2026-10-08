import { McpTerminalError } from '../errors.js';
import { runProviderTool } from './common.js';
import type { ProviderBackend, ProviderRun } from './common.js';

export function listVoices(backend: ProviderBackend, extra?: Record<string, unknown>): Promise<ProviderRun> {
  return runProviderTool(backend, {
    capability: 'lister les voix ElevenLabs',
    candidates: ['search_voices', 'get_voices', 'list_voices', /^(search|list|get)[-_]?(all[-_]?)?voices?$/i],
    wishes: [],
    ...(extra !== undefined ? { extra } : {}),
  });
}

export interface TtsOptions {
  voice?: string;
  voiceId?: string;
  model?: string;
  extra?: Record<string, unknown>;
}

export function textToSpeech(backend: ProviderBackend, text: string, options: TtsOptions = {}): Promise<ProviderRun> {
  if (text.trim() === '') throw new McpTerminalError('INVALID_ARGUMENT', 'Le texte à synthétiser est vide.');
  return runProviderTool(backend, {
    capability: 'synthèse vocale (text-to-speech) ElevenLabs',
    candidates: ['text_to_speech', /^(text[-_]?to[-_]?speech|tts)$/i, /text[-_]?to[-_]?speech/i],
    wishes: [
      { aliases: ['text', 'input', 'prompt'], value: text },
      { aliases: ['voice_name', 'voice'], value: options.voice },
      { aliases: ['voice_id', 'voiceId'], value: options.voiceId },
      { aliases: ['model_id', 'model'], value: options.model },
    ],
    ...(options.extra !== undefined ? { extra: options.extra } : {}),
  });
}
