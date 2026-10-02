/**
 * Speech-to-text via Workers AI Whisper (`@cf/openai/whisper-large-v3-turbo`).
 *
 * Whisper is not a chat model, so it does not fit the OpenAI-compatible
 * `/chat/completions` path behind {@link createWeldAI}. Like {@link evaluate},
 * this module talks to the Workers AI `run` endpoint directly: through the
 * worker's `AI` binding when it has one, else the Cloudflare REST API with the
 * same API token the gateway uses (`AI_GATEWAY_API_TOKEN`, else
 * `CLOUDFLARE_API_TOKEN`).
 *
 * The model takes a bounded clip. Callers with long recordings split the audio
 * themselves (see `@weldsuite/meet-domain` MP3 chunking) and offset the segment
 * timestamps of every chunk.
 *
 * @see https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
 */

import { GatewayConfigError } from './adapters/types.js';
import {
  resolveConfig,
  type CloudflareGatewayConfig,
  type WeldAiConfig,
} from './config.js';
import { workersAi } from './models.js';

/** Canonical model id of the transcription model. */
export const WHISPER_MODEL_ID = workersAi.whisper;

export interface TranscribeAudioInput {
  /** Raw audio bytes (MP3 / WAV / ...). Base64-encoded for the request. */
  audio: Uint8Array;
  /** ISO-639-1 language hint (`en`, `nl`, ...). Omit to auto-detect. */
  language?: string;
  /** Context prompt that biases vocabulary (names, jargon). */
  initialPrompt?: string;
  /** Voice-activity-detection pre-filter (drops silence). */
  vadFilter?: boolean;
}

export interface TranscribedSegment {
  /** Seconds from the start of THIS clip. */
  start: number;
  end: number;
  text: string;
}

export interface TranscribeAudioResult {
  text: string;
  segments: TranscribedSegment[];
  wordCount: number;
  /** Detected (or hinted) language code, when the model reports one. */
  language?: string;
  /** Clip duration in seconds, when the model reports one. */
  durationSeconds?: number;
  modelId: string;
}

/** Minimal shape of the Workers AI binding (`[ai] binding = "AI"`). */
interface AiBindingLike {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

function aiBinding(env: unknown): AiBindingLike | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const ai = (env as { AI?: unknown }).AI;
  return ai && typeof (ai as AiBindingLike).run === 'function' ? (ai as AiBindingLike) : undefined;
}

function isCloudflareConfig(value: unknown): value is CloudflareGatewayConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { provider?: string }).provider === 'cloudflare' &&
    typeof (value as { accountId?: unknown }).accountId === 'string' &&
    'defaultModel' in (value as object)
  );
}

/** Base64-encode bytes without building one giant `String.fromCharCode` argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Build the REST URL + auth headers for a Whisper `run` call. */
export function resolveTranscribeRequest(
  config: CloudflareGatewayConfig,
  modelId: string = WHISPER_MODEL_ID,
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    if (config.gateway) headers['cf-aig-gateway-id'] = config.gateway;
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${modelId}`,
      headers,
    };
  }

  if (config.gatewayToken) {
    headers['cf-aig-authorization'] = `Bearer ${config.gatewayToken}`;
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gateway ?? 'default'}/workers-ai/${modelId}`,
      headers,
    };
  }

  throw new GatewayConfigError(
    'cloudflare',
    'an AI binding, or AI_GATEWAY_API_TOKEN / CLOUDFLARE_API_TOKEN / CF_API_TOKEN (or CF_AIG_TOKEN)',
  );
}

/** Whether {@link transcribeAudio} can run with this env. */
export function isTranscribeConfigured(env?: object): boolean {
  if (aiBinding(env)) return true;
  try {
    resolveTranscribeRequest(resolveTranscribeConfig(env));
    return true;
  } catch {
    return false;
  }
}

function resolveTranscribeConfig(envOrConfig: object | WeldAiConfig | undefined): CloudflareGatewayConfig {
  if (isCloudflareConfig(envOrConfig)) return envOrConfig;
  const resolved = resolveConfig(envOrConfig);
  if (resolved.provider !== 'cloudflare') throw new GatewayConfigError('cloudflare', 'provider');
  return resolved;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Accept the bare Whisper output, the REST `{ result, success }` envelope and
 * the nested `{ result: { result } }` shape the unified endpoint can return.
 */
export function parseTranscribeResponse(raw: unknown): Omit<TranscribeAudioResult, 'modelId'> {
  let current: unknown = raw;
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== 'object') break;
    const obj = current as Record<string, unknown>;
    if ('text' in obj || 'segments' in obj) break;
    if (obj.success === false) {
      const errors = Array.isArray(obj.errors) ? JSON.stringify(obj.errors) : 'unknown error';
      throw new Error(`[@weldsuite/ai] Whisper API error: ${errors}`);
    }
    if (!('result' in obj) || obj.result === undefined) break;
    current = obj.result;
  }
  if (!current || typeof current !== 'object') {
    throw new Error('[@weldsuite/ai] Whisper returned an empty body');
  }

  const obj = current as Record<string, unknown>;
  const rawSegments = Array.isArray(obj.segments) ? obj.segments : [];
  const segments: TranscribedSegment[] = [];
  for (const entry of rawSegments) {
    if (!entry || typeof entry !== 'object') continue;
    const seg = entry as Record<string, unknown>;
    const text = typeof seg.text === 'string' ? seg.text.trim() : '';
    if (!text) continue;
    const start = num(seg.start) ?? 0;
    segments.push({ start, end: num(seg.end) ?? start, text });
  }

  const text =
    typeof obj.text === 'string' ? obj.text.trim() : segments.map((s) => s.text).join(' ');
  const info =
    obj.transcription_info && typeof obj.transcription_info === 'object'
      ? (obj.transcription_info as Record<string, unknown>)
      : {};
  const wordCount =
    num(obj.word_count) ?? text.split(/\s+/).filter((w) => w.length > 0).length;

  return {
    text,
    segments,
    wordCount,
    language: typeof info.language === 'string' ? info.language : undefined,
    durationSeconds: num(info.duration),
  };
}

/**
 * Transcribe one bounded audio clip with Whisper large v3 turbo.
 *
 * @example
 * ```ts
 * const { text, segments } = await transcribeAudio(env, { audio: mp3Bytes, language: 'nl' });
 * ```
 */
export async function transcribeAudio(
  envOrConfig: object | WeldAiConfig | undefined,
  input: TranscribeAudioInput,
): Promise<TranscribeAudioResult> {
  const body = {
    audio: bytesToBase64(input.audio),
    task: 'transcribe',
    ...(input.language ? { language: input.language } : {}),
    ...(input.initialPrompt ? { initial_prompt: input.initialPrompt } : {}),
    ...(input.vadFilter !== undefined ? { vad_filter: input.vadFilter } : {}),
  };

  const binding = isCloudflareConfig(envOrConfig) ? undefined : aiBinding(envOrConfig);
  let raw: unknown;
  if (binding) {
    const gateway = (envOrConfig as { CF_AI_GATEWAY?: unknown }).CF_AI_GATEWAY;
    raw = await binding.run(WHISPER_MODEL_ID, body, {
      gateway: { id: typeof gateway === 'string' && gateway ? gateway : 'default' },
    });
  } else {
    const config = resolveTranscribeConfig(envOrConfig);
    const { url, headers } = resolveTranscribeRequest(config);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `[@weldsuite/ai] Whisper transcribe failed (${res.status}) on cloudflare: ${detail.slice(0, 500)}`,
      );
    }
    raw = (await res.json()) as unknown;
  }

  return { ...parseTranscribeResponse(raw), modelId: WHISPER_MODEL_ID };
}
