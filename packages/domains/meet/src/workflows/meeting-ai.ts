/**
 * MeetingAiWorkflow — Cloudflare Workflow
 *
 * Everything AI that happens to a WeldMeet session AFTER the call, one class
 * with a discriminated payload (`kind`):
 *
 *  - `ingest-rtk-transcript`  RealtimeKit finished its post-meeting transcript
 *                             (`meeting.transcript` webhook): download it, keep
 *                             the raw file, store speaker segments, charge.
 *  - `ingest-rtk-summary`     RealtimeKit finished its summary (`meeting.summary`):
 *                             download it, store it on the session, charge.
 *  - `whisper-transcribe`     "Transcribe afterwards": run Whisper over the
 *                             stored audio of EVERY ready recording part, in
 *                             order, in MP3-aligned chunks, then charge.
 *  - `summarize`              Summarize a stored transcript (any source) with
 *                             Workers AI, then charge.
 *
 * Billing rules (see ../billing.ts): charge AFTER the result is stored, as its
 * own retried step, idempotent per session and kind; a charge failure never
 * fails the run (the work is done and delivered).
 *
 * Instance ids (set by the dispatcher, they make redeliveries safe):
 *   rtk-transcript-{sessionId}, rtk-summary-{sessionId},
 *   whisper-{transcriptionId}, summarize-{sessionId}-{runId}
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import {
  createWeldAI,
  generateText,
  recommended,
  transcribeAudio,
} from '@weldsuite/ai';
import { getSessionSummary, getSessionTranscript } from '@weldsuite/cloudflare-realtime';
import { getTenantDbForWorkspace, schema, type Database } from '@weldsuite/worker-kit/db';
import { eq } from 'drizzle-orm';
import { alignMp3Chunk, isMp3, mp3ChunkCount, mp3ChunkWindow, mp3DurationSeconds } from '../audio/mp3';
import {
  billableMinutes,
  chargeMeetingAi,
  getMeetingAiPricing,
  resolveMeetingMetering,
  type MeetingAiKind,
} from '../billing';
import { recordingsBucket, type MeetDomainEnv } from '../env';
import { parseRtkTranscript } from '../rtk-transcript';
import {
  loadSession,
  patchSession,
  publishSessionUpdated,
  rawTranscriptKey,
  readyParts,
  type MeetingSessionRow,
} from '../recordings';
import {
  TRANSCRIPT_PROVIDER,
  WHISPER_MODEL_NAME,
  findSessionTranscription,
  loadTranscriptText,
  markTranscriptionFailed,
  saveCompletedTranscript,
  type TranscriptSegmentInput,
} from '../transcript-store';

// ============================================================================
// Params
// ============================================================================

interface BaseParams {
  /** Clerk org id (the tenant key). */
  orgId: string;
  sessionId: string;
}

export interface IngestRtkTranscriptParams extends BaseParams {
  kind: 'ingest-rtk-transcript';
  rtkSessionId: string | null;
  /** Expiring URL from the webhook payload (CSV). */
  downloadUrl: string | null;
}

export interface IngestRtkSummaryParams extends BaseParams {
  kind: 'ingest-rtk-summary';
  rtkSessionId: string | null;
  downloadUrl: string | null;
}

export interface WhisperTranscribeParams extends BaseParams {
  kind: 'whisper-transcribe';
  transcriptionId: string;
  userId: string;
  /** RealtimeKit-style language code (`nl`, `en-US`, ...); omit to auto-detect. */
  language?: string;
}

export interface SummarizeParams extends BaseParams {
  kind: 'summarize';
  userId: string;
  /** Distinguishes re-runs for the charge idempotency key. */
  runId: string;
}

export type MeetingAiParams =
  | IngestRtkTranscriptParams
  | IngestRtkSummaryParams
  | WhisperTranscribeParams
  | SummarizeParams;

// ============================================================================
// Tunables
// ============================================================================

/**
 * Nominal bytes per Whisper request. About 4-8 minutes of MP3. UNVERIFIED
 * against Workers AI's request limits on a real hour-long file (the spike the
 * plan asked for): lower it here if the test environment rejects it.
 */
export const WHISPER_CHUNK_BYTES = 4 * 1024 * 1024;

/** Transcript characters handed to the summarizer (roughly 35k tokens). */
const SUMMARY_MAX_TRANSCRIPT_CHARS = 140_000;
/** Longest summary text we keep from RealtimeKit. */
const SUMMARY_MAX_CHARS = 100_000;

const READ_RETRIES = { limit: 4, delay: '20 seconds', backoff: 'exponential' } as const;
const DB_RETRIES = { limit: 3, delay: '5 seconds', backoff: 'exponential' } as const;
/** For checks that cannot get better by retrying. */
const NO_RETRY = { limit: 0, delay: '1 second' } as const;

const SUMMARY_SYSTEM_PROMPT = [
  'You write meeting summaries from a transcript.',
  'Write in the language the transcript is spoken in.',
  'Use Markdown with these sections when there is something to say: a short overview (2-3 sentences), "Key points", "Decisions", "Action items" (with the owner when a speaker names one).',
  'Only state what the transcript supports. Do not invent names, numbers or decisions.',
].join('\n');

// ============================================================================
// Helpers
// ============================================================================

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `en-US` / `nl` / `auto` -> Whisper's ISO-639-1 hint, or undefined to auto-detect. */
export function whisperLanguage(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const base = code.trim().split(/[-_]/)[0]?.toLowerCase();
  return base && /^[a-z]{2,3}$/.test(base) && base !== 'auto' ? base : undefined;
}

// ============================================================================
// Workflow
// ============================================================================

export class MeetingAiWorkflow extends WorkflowEntrypoint<MeetDomainEnv, MeetingAiParams> {
  async run(event: WorkflowEvent<MeetingAiParams>, step: WorkflowStep) {
    const p = event.payload;
    switch (p.kind) {
      case 'ingest-rtk-transcript':
        return this.ingestRtkTranscript(p, step);
      case 'ingest-rtk-summary':
        return this.ingestRtkSummary(p, step);
      case 'whisper-transcribe':
        return this.whisperTranscribe(p, step);
      case 'summarize':
        return this.summarize(p, step);
    }
  }

  // --------------------------------------------------------------------------
  // Shared
  // --------------------------------------------------------------------------

  private db(orgId: string): Promise<Database> {
    return getTenantDbForWorkspace(this.env, orgId);
  }

  /**
   * Charge a finished result as its own step. NEVER fails the run: the result is
   * already stored. Returns the credits charged (0 on failure / nothing due).
   */
  private async charge(
    step: WorkflowStep,
    p: BaseParams & { userId?: string },
    params: {
      kind: MeetingAiKind;
      /** Meeting seconds the charge is based on. */
      seconds: number;
      source: 'rtk' | 'whisper' | 'workers_ai';
      runId?: string;
    },
  ): Promise<number> {
    try {
      return await step.do(`charge-${params.kind}`, { retries: DB_RETRIES }, async () => {
        const pricing = await getMeetingAiPricing(this.env);
        const rate =
          params.kind === 'transcription'
            ? pricing.transcriptionCreditsPerMinute
            : pricing.summaryCreditsPerMinute;
        const metering = await resolveMeetingMetering(this.env, p.orgId, p.userId ?? 'system');
        const result = await chargeMeetingAi(metering, {
          kind: params.kind,
          sessionId: p.sessionId,
          minutes: billableMinutes(params.seconds),
          ratePerMinute: rate,
          source: params.source,
          runId: params.runId,
        });
        const db = await this.db(p.orgId);
        await patchSession(
          db,
          p.sessionId,
          params.kind === 'transcription'
            ? { transcriptionCreditsCharged: result.credits }
            : { summaryCreditsCharged: result.credits },
        );
        return result.credits;
      });
    } catch (error) {
      console.error(
        `[MeetingAi] ${params.kind} charge failed for ${p.sessionId} (result delivered, UNBILLED): ${errorMessage(error)}`,
      );
      return 0;
    }
  }

  private async emit(
    orgId: string,
    sessionId: string,
    extra: Record<string, unknown>,
    userId = 'system',
  ): Promise<void> {
    const db = await this.db(orgId);
    const session = await loadSession(db, sessionId);
    if (session) await publishSessionUpdated(this.env, db, orgId, session, extra, userId);
  }

  /** Meeting seconds to bill: the session's own duration, else what the transcript covers. */
  private billSeconds(session: MeetingSessionRow | null, fallbackSeconds: number): number {
    return session?.duration && session.duration > 0 ? session.duration : fallbackSeconds;
  }

  // --------------------------------------------------------------------------
  // ingest-rtk-transcript
  // --------------------------------------------------------------------------

  private async ingestRtkTranscript(p: IngestRtkTranscriptParams, step: WorkflowStep) {
    try {
      // 1. Keep the raw file (the URL expires in about 7 days). JSON first (it has
      //    end times), the webhook's CSV as the fallback.
      const raw = await step.do('download-transcript', { retries: READ_RETRIES }, async () => {
        const sources: string[] = [];
        if (p.rtkSessionId) {
          try {
            sources.push((await getSessionTranscript(this.env, p.rtkSessionId, 'JSON')).downloadUrl);
          } catch (e) {
            console.warn(`[MeetingAi] JSON transcript URL unavailable, using webhook URL: ${errorMessage(e)}`);
          }
        }
        if (p.downloadUrl) sources.push(p.downloadUrl);
        if (sources.length === 0) throw new Error('No transcript download URL available');

        let lastError: unknown;
        for (const url of sources) {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Transcript download failed with HTTP ${res.status}`);
            const text = await res.text();
            const format = text.trimStart().startsWith('[') ? 'json' : 'csv';
            const key = rawTranscriptKey(p.orgId, p.sessionId, format);
            await recordingsBucket(this.env).put(key, text, {
              httpMetadata: { contentType: format === 'json' ? 'application/json' : 'text/csv' },
            });
            return { key, format };
          } catch (e) {
            lastError = e;
          }
        }
        throw lastError;
      });

      // 2. Parse + store.
      const stored = await step.do('store-transcript', { retries: DB_RETRIES }, async () => {
        const obj = await recordingsBucket(this.env).get(raw.key);
        if (!obj) throw new Error('Stored transcript file disappeared');
        const parsed = parseRtkTranscript(await obj.text());
        const db = await this.db(p.orgId);
        const session = await loadSession(db, p.sessionId);
        const lastEndSeconds = parsed.segments.reduce((max, s) => Math.max(max, s.end), 0);
        const saved = await saveCompletedTranscript(db, {
          sessionId: p.sessionId,
          provider: TRANSCRIPT_PROVIDER.rtk,
          model: WHISPER_MODEL_NAME,
          language: session?.aiLanguage ?? null,
          segments: parsed.segments,
          metadata: {
            source: 'rtk',
            rawKey: raw.key,
            rawFormat: raw.format,
            rtkSessionId: p.rtkSessionId,
          },
        });
        if (session) {
          await publishSessionUpdated(this.env, db, p.orgId, session, {
            transcriptionStatus: 'completed',
          });
        }
        return { transcriptionId: saved.id, lastEndSeconds };
      });

      // 3. Charge per meeting minute.
      const db = await this.db(p.orgId);
      const session = await loadSession(db, p.sessionId);
      await this.charge(step, p, {
        kind: 'transcription',
        seconds: this.billSeconds(session, stored.lastEndSeconds),
        source: 'rtk',
      });
    } catch (error) {
      await this.failTranscription(p, errorMessage(error));
      throw error;
    }
  }

  private async failTranscription(
    p: BaseParams,
    message: string,
    transcriptionId?: string,
  ): Promise<void> {
    console.error(`[MeetingAi] transcription failed for ${p.sessionId}: ${message}`);
    try {
      const db = await this.db(p.orgId);
      await markTranscriptionFailed(db, p.sessionId, message, transcriptionId);
      const session = await loadSession(db, p.sessionId);
      if (session) {
        await publishSessionUpdated(this.env, db, p.orgId, session, { transcriptionStatus: 'failed' });
      }
    } catch (updateError) {
      console.error(`[MeetingAi] could not record transcription failure: ${errorMessage(updateError)}`);
    }
  }

  // --------------------------------------------------------------------------
  // ingest-rtk-summary
  // --------------------------------------------------------------------------

  private async ingestRtkSummary(p: IngestRtkSummaryParams, step: WorkflowStep) {
    try {
      const text = await step.do('download-summary', { retries: READ_RETRIES }, async () => {
        const sources: string[] = [];
        if (p.downloadUrl) sources.push(p.downloadUrl);
        if (p.rtkSessionId) {
          try {
            sources.push((await getSessionSummary(this.env, p.rtkSessionId)).downloadUrl);
          } catch (e) {
            console.warn(`[MeetingAi] summary URL unavailable: ${errorMessage(e)}`);
          }
        }
        if (sources.length === 0) throw new Error('No summary download URL available');

        let lastError: unknown;
        for (const url of sources) {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Summary download failed with HTTP ${res.status}`);
            const body = (await res.text()).trim();
            if (!body) throw new Error('Summary file is empty');
            return body.slice(0, SUMMARY_MAX_CHARS);
          } catch (e) {
            lastError = e;
          }
        }
        throw lastError;
      });

      await step.do('store-summary', { retries: DB_RETRIES }, async () => {
        const db = await this.db(p.orgId);
        const session = await loadSession(db, p.sessionId);
        if (!session) return;
        await patchSession(db, p.sessionId, {
          summaryStatus: 'completed',
          summaryText: text,
          summaryFormat: 'markdown',
          summarySource: 'rtk',
          summaryGeneratedAt: new Date(),
          summaryError: null,
        });
        await publishSessionUpdated(this.env, db, p.orgId, session, { summaryStatus: 'completed' });
      });

      const db = await this.db(p.orgId);
      const session = await loadSession(db, p.sessionId);
      await this.charge(step, p, {
        kind: 'summary',
        seconds: this.billSeconds(session, 0),
        source: 'rtk',
      });
    } catch (error) {
      await this.failSummary(p, errorMessage(error));
      throw error;
    }
  }

  private async failSummary(p: BaseParams, message: string): Promise<void> {
    console.error(`[MeetingAi] summary failed for ${p.sessionId}: ${message}`);
    try {
      const db = await this.db(p.orgId);
      const session = await loadSession(db, p.sessionId);
      if (!session) return;
      await patchSession(db, p.sessionId, { summaryStatus: 'failed', summaryError: message.slice(0, 1000) });
      await publishSessionUpdated(this.env, db, p.orgId, session, { summaryStatus: 'failed' });
    } catch (updateError) {
      console.error(`[MeetingAi] could not record summary failure: ${errorMessage(updateError)}`);
    }
  }

  // --------------------------------------------------------------------------
  // whisper-transcribe
  // --------------------------------------------------------------------------

  private async whisperTranscribe(p: WhisperTranscribeParams, step: WorkflowStep) {
    try {
      // 1. Plan: which stored audio files, in order. Not retried: a wrong format
      //    or missing audio will not fix itself.
      const plan = await step.do('plan', { retries: NO_RETRY }, async () => {
        const db = await this.db(p.orgId);
        const session = await loadSession(db, p.sessionId);
        if (!session) throw new Error('Session not found');
        const bucket = recordingsBucket(this.env);

        const keys = readyParts(session.recordingParts)
          .filter((part) => part.audioKey)
          .map((part) => ({ key: part.audioKey!, durationSeconds: part.durationSeconds }));
        if (keys.length === 0 && session.recordingAudioKey) {
          keys.push({ key: session.recordingAudioKey, durationSeconds: session.recordingDurationSeconds });
        }
        if (keys.length === 0) throw new Error('No stored audio to transcribe');

        const audios: Array<{ key: string; size: number; durationSeconds: number | null }> = [];
        for (const entry of keys) {
          const head = await bucket.head(entry.key);
          if (!head) throw new Error(`Audio file ${entry.key} is missing from storage`);
          const sample = await bucket.get(entry.key, { range: { offset: 0, length: 64 * 1024 } });
          const bytes = sample ? new Uint8Array(await sample.arrayBuffer()) : new Uint8Array(0);
          if (!isMp3(bytes)) {
            throw new Error('The stored audio is not MP3, so it cannot be split for transcription');
          }
          audios.push({ key: entry.key, size: head.size, durationSeconds: entry.durationSeconds });
        }

        await db
          .update(schema.crmTranscriptions)
          .set({ status: 'processing', processingStartedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.crmTranscriptions.id, p.transcriptionId));
        await publishSessionUpdated(this.env, db, p.orgId, session, { transcriptionStatus: 'processing' }, p.userId);
        return { audios, sessionDuration: session.duration ?? null };
      });

      // 2. One retried step per chunk, offsetting timestamps as we go.
      const language = whisperLanguage(p.language);
      const segments: TranscriptSegmentInput[] = [];
      let offset = 0;
      let detectedLanguage: string | undefined;
      let measuredSeconds = 0;

      for (let a = 0; a < plan.audios.length; a++) {
        const audio = plan.audios[a]!;
        const chunks = mp3ChunkCount(audio.size, WHISPER_CHUNK_BYTES);
        for (let k = 0; k < chunks; k++) {
          const chunk = await step.do(
            `whisper-${a}-${k}`,
            { retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
            async () => {
              const window = mp3ChunkWindow(audio.size, WHISPER_CHUNK_BYTES, k);
              const obj = await recordingsBucket(this.env).get(audio.key, {
                range: { offset: window.offset, length: window.length },
              });
              if (!obj) throw new Error(`Audio file ${audio.key} is missing from storage`);
              const clip = alignMp3Chunk(new Uint8Array(await obj.arrayBuffer()), WHISPER_CHUNK_BYTES, {
                index: k,
                isLast: window.isLast,
              });
              if (clip.length === 0) return { segments: [], durationSeconds: 0, language: null };
              const result = await transcribeAudio(this.env, { audio: clip, language, vadFilter: true });
              return {
                segments: result.segments,
                durationSeconds: mp3DurationSeconds(clip),
                language: result.language ?? null,
              };
            },
          );
          for (const seg of chunk.segments) {
            segments.push({
              speakerId: 0,
              speakerLabel: 'Speaker',
              speakerName: null,
              text: seg.text,
              start: offset + seg.start,
              end: offset + seg.end,
            });
          }
          offset += chunk.durationSeconds;
          measuredSeconds += chunk.durationSeconds;
          if (!detectedLanguage && chunk.language) detectedLanguage = chunk.language;
        }
      }

      // 3. Store.
      const partSeconds = plan.audios.every((a) => a.durationSeconds && a.durationSeconds > 0)
        ? plan.audios.reduce((sum, a) => sum + (a.durationSeconds ?? 0), 0)
        : measuredSeconds;
      // Billed on the summed part durations, capped at the session length.
      const billedSeconds =
        plan.sessionDuration && plan.sessionDuration > 0 ? Math.min(partSeconds, plan.sessionDuration) : partSeconds;

      await step.do('store-transcript', { retries: DB_RETRIES }, async () => {
        const db = await this.db(p.orgId);
        await saveCompletedTranscript(db, {
          sessionId: p.sessionId,
          transcriptionId: p.transcriptionId,
          provider: TRANSCRIPT_PROVIDER.whisper,
          model: WHISPER_MODEL_NAME,
          language: detectedLanguage ?? language ?? null,
          segments,
          metadata: {
            source: 'whisper',
            parts: plan.audios.map((a) => a.key),
            billedSeconds,
          },
        });
        const session = await loadSession(db, p.sessionId);
        if (session) {
          await publishSessionUpdated(this.env, db, p.orgId, session, { transcriptionStatus: 'completed' }, p.userId);
        }
      });

      // 4. Charge (separate run per transcription so a second pass after a delete bills again).
      await this.charge(step, p, {
        kind: 'transcription',
        seconds: billedSeconds,
        source: 'whisper',
        runId: p.transcriptionId,
      });
    } catch (error) {
      await this.failTranscription(p, errorMessage(error), p.transcriptionId);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // summarize
  // --------------------------------------------------------------------------

  private async summarize(p: SummarizeParams, step: WorkflowStep) {
    try {
      await step.do('mark-processing', { retries: DB_RETRIES }, async () => {
        const db = await this.db(p.orgId);
        const session = await loadSession(db, p.sessionId);
        if (!session) throw new Error('Session not found');
        await patchSession(db, p.sessionId, { summaryStatus: 'processing', summaryError: null });
        await publishSessionUpdated(this.env, db, p.orgId, session, { summaryStatus: 'processing' }, p.userId);
      });

      const generated = await step.do(
        'generate-summary',
        { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
        async () => {
          const db = await this.db(p.orgId);
          const transcription = await findSessionTranscription(db, p.sessionId);
          if (!transcription || transcription.status !== 'completed') {
            throw new Error('There is no completed transcript to summarize');
          }
          const { text, lastEndSeconds } = await loadTranscriptText(db, transcription.id);
          if (!text.trim()) throw new Error('The transcript is empty');

          const ai = createWeldAI(this.env);
          const result = await generateText({
            model: ai.model(recommended.summarize.free),
            system: SUMMARY_SYSTEM_PROMPT,
            prompt: `Transcript:\n\n${text.slice(0, SUMMARY_MAX_TRANSCRIPT_CHARS)}`,
          });
          const summary = result.text.trim();
          if (!summary) throw new Error('The model returned an empty summary');
          return { summary, lastEndSeconds };
        },
      );

      await step.do('store-summary', { retries: DB_RETRIES }, async () => {
        const db = await this.db(p.orgId);
        const session = await loadSession(db, p.sessionId);
        if (!session) return;
        await patchSession(db, p.sessionId, {
          summaryStatus: 'completed',
          summaryText: generated.summary,
          summaryFormat: 'markdown',
          summarySource: 'workers_ai',
          summaryGeneratedAt: new Date(),
          summaryError: null,
        });
        await publishSessionUpdated(this.env, db, p.orgId, session, { summaryStatus: 'completed' }, p.userId);
      });

      const db = await this.db(p.orgId);
      const session = await loadSession(db, p.sessionId);
      await this.charge(step, p, {
        kind: 'summary',
        seconds: this.billSeconds(session, generated.lastEndSeconds),
        source: 'workers_ai',
        runId: p.runId,
      });
    } catch (error) {
      await this.failSummary(p, errorMessage(error));
      throw error;
    }
  }
}
