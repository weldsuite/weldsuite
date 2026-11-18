/**
 * Telnyx live transcription (`transcription_start` / `transcription_stop`) for
 * the call translation. The engine, the model and the shape of
 * `transcription_engine_config` live here and nowhere else: only a live call
 * can confirm them, so a test call adjusts this one module.
 *
 * Transcripts come back as `call.transcription` webhooks of the leg they were
 * started on, carrying that leg's own `client_state`. Neither command sends a
 * `client_state`: Telnyx applies a command's state to the leg's later
 * webhooks, and a new one would wipe what tells an agent's leg from the
 * caller's (`agentLegId`), so the agent's hangup would be taken for the
 * call's.
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
  args: { language: string | null; track?: TranscriptionTrack },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'transcription_start', {
    ...transcriptionEngineFields(args.language),
    transcription_tracks: args.track ?? 'inbound',
  });
}

export async function telnyxTranscriptionStop(env: TelnyxEnv, callControlId: string): Promise<unknown> {
  return callControlAction(env, callControlId, 'transcription_stop', {});
}
