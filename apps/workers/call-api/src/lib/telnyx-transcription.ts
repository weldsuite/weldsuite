/**
 * Telnyx live transcription (`transcription_start` / `transcription_stop`) for
 * the call translation. The engine, the model and the shape of
 * `transcription_engine_config` live here and nowhere else: only a live call
 * can confirm them, so a test call adjusts this one module.
 *
 * Transcripts come back as `call.transcription` webhooks carrying the
 * `client_state` given at start.
 */

import { callControlAction, type TelnyxEnv } from './telnyx';

/** Telnyx's own engine (legacy alias `B`). */
export const TRANSCRIPTION_ENGINE = 'Telnyx';
export const TRANSCRIPTION_MODEL = 'openai/whisper-large-v3-turbo';
/** `transcription_engine_config.language` that lets the engine detect the language. */
export const TRANSCRIPTION_AUTO_DETECT = 'auto_detect';

/**
 * `inbound` is the leg that requested the transcription: the party on that
 * leg. (`outbound` is the other leg, `both` both.)
 */
export type TranscriptionTrack = 'inbound' | 'outbound' | 'both';

/** The engine fields of a start command for `language` (a primary tag, or null to detect). */
export function transcriptionEngineFields(language: string | null): Record<string, unknown> {
  return {
    transcription_engine: TRANSCRIPTION_ENGINE,
    transcription_engine_config: {
      transcription_model: TRANSCRIPTION_MODEL,
      language: language ?? TRANSCRIPTION_AUTO_DETECT,
      // Only finished lines are translated.
      interim_results: false,
    },
  };
}

export async function telnyxTranscriptionStart(
  env: TelnyxEnv,
  callControlId: string,
  args: { language: string | null; track?: TranscriptionTrack; clientState: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'transcription_start', {
    ...transcriptionEngineFields(args.language),
    transcription_tracks: args.track ?? 'inbound',
    client_state: args.clientState,
  });
}

export async function telnyxTranscriptionStop(
  env: TelnyxEnv,
  callControlId: string,
  opts?: { clientState?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'transcription_stop', {
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}
