/**
 * TranscribeRecordingWorkflow — Cloudflare Workflow
 *
 * Transcribes call/meeting recordings using AssemblyAI.
 * Uses raw fetch() to the AssemblyAI REST API (no SDK dependency).
 *
 * Steps:
 * 1. mark-processing — update transcription status
 * 2. transcribe — call AssemblyAI API
 * 3. store-results — save text + segments to DB
 * 4. deduct-credits — deduct from workspace balance
 *
 * Ported from apps/api-worker/src/workflows/transcribe-recording.ts (W4
 * legacy-worker phase-out). Hosted in app-api under the NEW workflow names
 * `transcribe-recording-v2[-dev/-test/-preview]` — the old names stay owned
 * by api-worker while its in-flight instances drain. Bound as
 * TRANSCRIBE_RECORDING; the dispatch site in routes/meetings is unchanged.
 * Requires the ASSEMBLYAI_API_KEY secret (copy from api-worker per env).
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema, getMasterDb, masterSchema } from '../db';
import { generateId } from '../lib/id';

// ============================================================================
// Types
// ============================================================================

export interface TranscribeRecordingParams {
  transcriptionId: string;
  fileKey?: string;
  fileUrl?: string;
  language?: string;
  estimatedMinutes: number;
  creditRate: number;
  entityId: string;
  workspaceId: string;
}

interface TranscriptionWordTiming {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speakerId: number;
  speakerLabel: string;
  words?: TranscriptionWordTiming[];
}

interface TranscribeResult {
  text: string;
  segments: TranscriptionSegment[];
  speakerCount: number;
  confidence: number | null;
  detectedLanguage?: string;
  actualMinutes: number;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ============================================================================
// AssemblyAI (via REST API)
// ============================================================================

async function assemblyTranscribe(
  audioUrl: string,
  language: string | undefined,
  apiKey: string,
): Promise<TranscribeResult> {
  // Submit transcription request
  const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speaker_labels: true,
      language_code: language || undefined,
    }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`AssemblyAI submit failed (${submitRes.status}): ${body}`);
  }

  const { id: transcriptId } = await submitRes.json<{ id: string }>();

  // Poll until complete
  let transcript: any;
  while (true) {
    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });

    if (!pollRes.ok) {
      throw new Error(`AssemblyAI poll failed (${pollRes.status})`);
    }

    transcript = await pollRes.json();

    if (transcript.status === 'completed') break;
    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }

    // Wait 3 seconds before polling again
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  // Parse segments from utterances
  const segments: TranscriptionSegment[] = [];
  const speakerSet = new Set<string>();

  if (transcript.utterances) {
    for (const utterance of transcript.utterances) {
      const speaker: string = utterance.speaker;
      speakerSet.add(speaker);
      const speakerIndex = speaker.charCodeAt(0) - 'A'.charCodeAt(0);

      const words: TranscriptionWordTiming[] = (utterance.words || []).map((w: any) => ({
        text: w.text,
        start: w.start / 1000,
        end: w.end / 1000,
        confidence: w.confidence ?? 0,
      }));

      segments.push({
        start: utterance.start / 1000,
        end: utterance.end / 1000,
        text: utterance.text,
        speakerId: speakerIndex,
        speakerLabel: `Speaker ${speakerIndex + 1}`,
        words,
      });
    }
  }

  // audio_duration is in seconds from the API
  const audioDuration = transcript.audio_duration || 0;
  const actualMinutes = audioDuration > 0 ? Math.ceil(audioDuration / 60) : 0;

  return {
    text: transcript.text || '',
    segments,
    speakerCount: speakerSet.size,
    confidence: transcript.confidence ?? null,
    detectedLanguage: transcript.language_code || undefined,
    actualMinutes,
  };
}

// ============================================================================
// Workflow
// ============================================================================

export class TranscribeRecordingWorkflow extends WorkflowEntrypoint<Env, TranscribeRecordingParams> {
  async run(event: WorkflowEvent<TranscribeRecordingParams>, step: WorkflowStep) {
    const {
      transcriptionId,
      fileKey,
      fileUrl,
      language,
      estimatedMinutes,
      creditRate,
      entityId,
      workspaceId,
    } = event.payload;

    try {
      // Step 1: Mark as processing
      await step.do('mark-processing', {
        retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);
        await db
          .update(schema.crmTranscriptions)
          .set({
            status: 'processing',
            processingStartedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.crmTranscriptions.id, transcriptionId));
      });

      // Step 2: Transcribe via AssemblyAI
      const result = await step.do('transcribe', {
        retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
      }, async () => {
        const apiKey = this.env.ASSEMBLYAI_API_KEY;
        if (!apiKey) {
          throw new Error('ASSEMBLYAI_API_KEY not configured');
        }

        // Resolve audio URL
        let audioUrl: string;

        if (fileKey) {
          audioUrl = `${this.env.R2_PUBLIC_URL}/${fileKey}`;
        } else if (fileUrl) {
          // Telnyx recording URLs are publicly accessible (signed), pass directly
          audioUrl = fileUrl;
        } else {
          throw new Error('No audio source available (no fileKey or fileUrl)');
        }

        return await assemblyTranscribe(audioUrl, language, apiKey);
      });

      // Step 3: Store results in DB
      await step.do('store-results', {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);

        const wordCount = result.text
          .split(/\s+/)
          .filter((w: string) => w.length > 0).length;

        await db
          .update(schema.crmTranscriptions)
          .set({
            status: 'completed',
            fullText: result.text,
            model: 'assemblyai-universal',
            provider: 'assemblyai',
            language: result.detectedLanguage || language || 'en',
            wordCount,
            speakerCount: result.speakerCount,
            confidence: result.confidence,
            processingCompletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.crmTranscriptions.id, transcriptionId));

        // Delete existing segments, then insert new ones
        await db
          .delete(schema.crmTranscriptSegments)
          .where(eq(schema.crmTranscriptSegments.transcriptionId, transcriptionId));

        if (result.segments.length > 0) {
          const segmentRows = result.segments.map((seg: TranscriptionSegment, index: number) => ({
            id: generateId('seg'),
            transcriptionId,
            speakerId: seg.speakerId,
            speakerLabel: seg.speakerLabel,
            text: seg.text,
            startTime: seg.start,
            endTime: seg.end,
            timestamp: formatTimestamp(seg.start),
            sequenceNumber: index,
            words: seg.words || null,
          }));

          // Insert in batches of 100
          for (let i = 0; i < segmentRows.length; i += 100) {
            const batch = segmentRows.slice(i, i + 100);
            await db.insert(schema.crmTranscriptSegments).values(batch);
          }
        }

        console.log(`[Transcribe] Stored: ${wordCount} words, ${result.segments.length} segments, ${result.speakerCount} speakers`);
      });

      // Step 4: Deduct credits (failure here should NOT fail the transcription)
      await step.do('deduct-credits', {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
      }, async () => {
        try {
          const actualMinutes = result.actualMinutes || estimatedMinutes;
          const creditsToDeduct = actualMinutes * creditRate;
          if (creditsToDeduct <= 0) return;

          const mdb = getMasterDb(this.env);

          const [credits] = await mdb
            .select()
            .from(masterSchema.workspaceCredits)
            .where(eq(masterSchema.workspaceCredits.workspaceId, workspaceId))
            .limit(1);

          if (!credits) return;

          const newBalance = Math.max(0, credits.currentBalance - creditsToDeduct);

          await mdb
            .update(masterSchema.workspaceCredits)
            .set({
              currentBalance: newBalance,
              updatedAt: new Date(),
            })
            .where(eq(masterSchema.workspaceCredits.workspaceId, workspaceId));

          await mdb.insert(masterSchema.creditTransactions).values({
            id: generateId('ctx'),
            workspaceId,
            type: 'consumption',
            amount: -creditsToDeduct,
            balanceAfter: newBalance,
            serviceType: 'call_transcription',
            referenceId: entityId,
            referenceType: 'call_transcription',
            description: `Call transcription: ${actualMinutes} minutes`,
            metadata: {
              durationMinutes: actualMinutes,
              estimatedMinutes,
              provider: 'assemblyai',
              transcriptionId,
            },
            createdAt: new Date(),
          });

          console.log(`[Transcribe] Deducted ${creditsToDeduct} credits (${actualMinutes} min * ${creditRate}/min, balance: ${newBalance})`);
        } catch (creditError) {
          // Don't fail the transcription if credit deduction fails
          console.warn(`[Transcribe] Credit deduction failed: ${creditError instanceof Error ? creditError.message : String(creditError)}`);
        }
      });

      console.log(`[Transcribe] Completed ${transcriptionId} for entity ${entityId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Transcribe] Failed: ${errorMessage}`);

      // Mark as failed
      try {
        const db = await getTenantDbForWorkspace(this.env, workspaceId);
        await db
          .update(schema.crmTranscriptions)
          .set({
            status: 'failed',
            errorMessage,
            updatedAt: new Date(),
          })
          .where(eq(schema.crmTranscriptions.id, transcriptionId));
      } catch (updateError) {
        console.error(`[Transcribe] Failed to update status: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
      }

      throw error;
    }
  }
}
