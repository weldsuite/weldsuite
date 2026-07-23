/**
 * MeetingBaas Webhook — service handlers.
 *
 * Ported from apps/api-worker/src/routes/webhooks/meeting-bot.ts
 * (legacy worker phase-out, W3). Handles meeting-bot lifecycle events:
 * - bot.status_change: status mapping onto meeting_bot_sessions
 * - complete / bot.completed: recording persist (R2), credit deduction,
 *   native transcript storage
 * - failed / bot.failed: error capture
 *
 * Context-free (env only) so the route stays a thin dispatcher.
 * Delta vs api-worker: mutations now also publish entity events via
 * publishEntityEventRaw (meeting_bot_session catalog type).
 */

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import {
  getTenantDbForWorkspace,
  getMasterDb,
  schema,
  masterSchema,
  type Database,
} from '../db';
import type { Env } from '../types';

// ============================================================================
// Types
// ============================================================================

export interface MeetingBaasWebhookPayload {
  event: string;
  extra?: {
    platformSessionId?: string;
    workspaceId?: string;
    contactId?: string;
    opportunityId?: string;
  };
  // Data object (MeetingBaas wraps most fields here)
  data?: {
    bot_id?: string;
    event_id?: string | null;
    // MeetingBaas can also nest `extra` inside `data`
    extra?: {
      platformSessionId?: string;
      workspaceId?: string;
      contactId?: string;
      opportunityId?: string;
    };
    status?: {
      code?: string;
      message?: string;
      created_at?: string;
    };
    // complete event data
    video?: string; // MP4 recording URL (current MeetingBaas field name)
    audio?: string; // Audio recording URL (FLAC)
    mp4?: string; // Legacy field name for video
    duration_seconds?: number;
    joined_at?: string;
    exited_at?: string;
    participants?: Array<{
      name: string;
      id: number;
      display_name?: string;
      profile_picture?: string;
    }>;
    transcript?: Array<{
      speaker: string;
      offset?: number;
      start_time: number;
      end_time: number;
      words: Array<{ start: number; end: number; word: string }>;
    }>;
    speakers?: string[];
    diarization?: unknown;
    raw_transcription?: unknown;
    transcription_provider?: string;
    // failed event data
    error?: string;
    message?: string;
  };
  // Legacy top-level fields (keep for backwards compatibility)
  bot_id?: string;
  mp4?: string;
  transcript?: Array<{
    speaker: string;
    offset?: number;
    start_time: number;
    end_time: number;
    words: Array<{ start: number; end: number; word: string }>;
  }>;
  speakers?: string[];
  error?: string;
  message?: string;
  status?: {
    code?: string;
    message?: string;
  };
}

// Normalized payload with extracted fields
export interface NormalizedMeetingBaasPayload extends MeetingBaasWebhookPayload {
  _botId?: string;
  _statusCode: string;
  _statusMessage: string;
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

/** Fire-and-forget entity event for a meeting_bot_session mutation. */
async function publishBotSessionEvent(
  env: Env,
  db: Database,
  workspaceId: string,
  action: 'updated' | 'completed',
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEntityEventRaw({
      env,
      db,
      workspaceId,
      userId: 'system',
      entityType: 'meeting_bot_session',
      action,
      entityId: sessionId,
      data,
      source: 'system',
    });
  } catch (err) {
    console.error('[MeetingBaas Webhook] Entity event publish failed:', err);
  }
}

/**
 * Find platform session by bot_id or platformSessionId.
 * First uses workspaceId from the payload, then searches tenant DBs.
 */
async function findPlatformSession(env: Env, payload: NormalizedMeetingBaasPayload) {
  const botId = payload._botId;
  const platformSessionId = payload.extra?.platformSessionId;
  const workspaceId = payload.extra?.workspaceId;

  // If we have workspaceId, use it directly
  if (workspaceId && platformSessionId) {
    try {
      const db = await getTenantDbForWorkspace(env, workspaceId);
      const { meetingBotSessions } = schema;

      const [session] = await db
        .select()
        .from(meetingBotSessions)
        .where(eq(meetingBotSessions.id, platformSessionId))
        .limit(1);

      if (session) {
        return { session, workspaceId };
      }
    } catch (error) {
      console.error('[MeetingBaas Webhook] Failed to query tenant DB:', error);
    }
  }

  // If we have workspaceId and botId, search by externalSessionId
  if (workspaceId && botId) {
    try {
      const db = await getTenantDbForWorkspace(env, workspaceId);
      const { meetingBotSessions } = schema;

      const [session] = await db
        .select()
        .from(meetingBotSessions)
        .where(eq(meetingBotSessions.externalSessionId, botId))
        .limit(1);

      if (session) {
        return { session, workspaceId };
      }
    } catch (error) {
      console.error('[MeetingBaas Webhook] Failed to query tenant DB:', error);
    }
  }

  // Fallback: Search all workspaces (expensive, but necessary if workspaceId not provided)
  if (platformSessionId || botId) {
    console.warn('[MeetingBaas Webhook] No workspaceId provided, searching all workspaces...');

    try {
      const masterDb = getMasterDb(env);
      const workspaces = await masterDb
        .select({ id: masterSchema.workspaces.id, clerkOrgId: masterSchema.workspaces.clerkOrgId })
        .from(masterSchema.workspaces)
        .where(eq(masterSchema.workspaces.isActive, true))
        .limit(100); // Limit to prevent excessive queries

      for (const workspace of workspaces) {
        if (!workspace.clerkOrgId) continue;

        try {
          const db = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
          const { meetingBotSessions } = schema;

          if (platformSessionId) {
            const [session] = await db
              .select()
              .from(meetingBotSessions)
              .where(eq(meetingBotSessions.id, platformSessionId))
              .limit(1);

            if (session) {
              return { session, workspaceId: workspace.clerkOrgId };
            }
          }

          if (botId) {
            const [session] = await db
              .select()
              .from(meetingBotSessions)
              .where(eq(meetingBotSessions.externalSessionId, botId))
              .limit(1);

            if (session) {
              return { session, workspaceId: workspace.clerkOrgId };
            }
          }
        } catch {
          // Skip workspaces that fail
          continue;
        }
      }
    } catch (error) {
      console.error('[MeetingBaas Webhook] Failed to search workspaces:', error);
    }
  }

  return null;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Handle bot.status_change event
 */
export async function handleStatusChange(
  env: Env,
  payload: NormalizedMeetingBaasPayload,
): Promise<void> {
  const statusCode = payload._statusCode;
  console.log(`[MeetingBaas Webhook] Status change: code=${statusCode}, message=${payload._statusMessage}`);

  const result = await findPlatformSession(env, payload);
  if (!result) {
    console.warn('[MeetingBaas Webhook] Session not found for status_change');
    return;
  }

  const { session, workspaceId } = result;
  console.log(`[MeetingBaas Webhook] Current session status: ${session.status}`);

  // Don't downgrade terminal states
  const terminalStates = ['completed', 'failed'];
  if (terminalStates.includes(session.status)) {
    console.log(`[MeetingBaas Webhook] Skipping status update - session already in terminal state: ${session.status}`);
    return;
  }

  const db = await getTenantDbForWorkspace(env, workspaceId);
  const { meetingBotSessions } = schema;

  const statusMap: Record<string, string> = {
    joining_call: 'joining',
    in_waiting_room: 'joining',
    in_call_not_recording: 'connected',
    in_call_recording: 'recording',
    call_ended: 'left',
  };

  const internalStatus = statusMap[statusCode] || session.status;

  const updates: Record<string, unknown> = {
    status: internalStatus,
    updatedAt: new Date(),
  };

  // Set joinedAt when bot first connects
  if (
    (statusCode === 'in_call_not_recording' || statusCode === 'in_call_recording') &&
    !session.joinedAt
  ) {
    updates.joinedAt = new Date();
  }

  await db
    .update(meetingBotSessions)
    .set(updates)
    .where(eq(meetingBotSessions.id, session.id));

  console.log(`[MeetingBaas Webhook] Status updated: ${session.id} -> ${internalStatus}`);

  await publishBotSessionEvent(env, db, workspaceId, 'updated', session.id, {
    ...session,
    status: internalStatus,
  });
}

/**
 * Handle complete event - recording finished
 */
export async function handleComplete(
  env: Env,
  payload: NormalizedMeetingBaasPayload,
): Promise<void> {
  console.log('[MeetingBaas Webhook] Processing complete event');

  const result = await findPlatformSession(env, payload);
  if (!result) {
    console.error('[MeetingBaas Webhook] Session not found for complete');
    return;
  }

  const { session, workspaceId } = result;
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const { meetingBotSessions } = schema;

  // Extract fields: MeetingBaas uses `video` (not `mp4`) for the recording URL
  const mp4Url = payload.data?.video || payload.data?.mp4 || payload.mp4;
  const transcript = payload.data?.transcript || payload.transcript;
  const speakers = payload.data?.speakers || payload.speakers;
  const participants = payload.data?.participants;
  const durationSeconds = payload.data?.duration_seconds;
  const joinedAt = payload.data?.joined_at;
  const exitedAt = payload.data?.exited_at;

  console.log('[MeetingBaas Webhook] Recording URL:', mp4Url ? mp4Url.substring(0, 80) + '...' : 'NOT PROVIDED');
  console.log('[MeetingBaas Webhook] Duration:', durationSeconds ?? 'unknown');
  console.log('[MeetingBaas Webhook] Participants:', participants?.length || 0);
  console.log('[MeetingBaas Webhook] Transcript segments:', transcript?.length || 0);

  // Use MeetingBaas duration, fall back to transcript-based calculation
  let duration = durationSeconds || 0;
  if (!duration && transcript?.length) {
    const lastSegment = transcript[transcript.length - 1];
    duration = Math.ceil(lastSegment.end_time);
  }

  const updates: Record<string, unknown> = {
    status: 'completed',
    leftAt: exitedAt ? new Date(exitedAt) : new Date(),
    duration,
    participantCount: participants?.length || speakers?.length || 0,
    updatedAt: new Date(),
  };

  // Set joinedAt if not already set
  if (joinedAt && !session.joinedAt) {
    updates.joinedAt = new Date(joinedAt);
  }

  // Store the recording URL directly
  if (mp4Url) {
    updates.recordingStorageUrl = mp4Url;
    updates.recordingDuration = duration;
  }

  await db
    .update(meetingBotSessions)
    .set(updates)
    .where(eq(meetingBotSessions.id, session.id));

  console.log(`[MeetingBaas Webhook] Recording completed: ${session.id}`);

  // Upload MP4 to R2 for permanent storage (MeetingBaas URLs expire)
  if (mp4Url && env.STORAGE) {
    try {
      const timestamp = Date.now();
      const r2Key = `recordings/meetings/${workspaceId}/${timestamp}-${session.id}.mp4`;

      console.log(`[MeetingBaas Webhook] Fetching MP4 for R2 upload: ${mp4Url}`);
      const mp4Response = await fetch(mp4Url);

      if (!mp4Response.ok) {
        throw new Error(`Failed to fetch MP4: ${mp4Response.status} ${mp4Response.statusText}`);
      }

      await env.STORAGE.put(r2Key, mp4Response.body, {
        httpMetadata: { contentType: 'video/mp4' },
      });

      // Update session with the R2 storage key
      await db
        .update(meetingBotSessions)
        .set({
          recordingStorageKey: r2Key,
          recordingFileSize: mp4Response.headers.get('content-length')
            ? parseInt(mp4Response.headers.get('content-length')!, 10)
            : null,
          updatedAt: new Date(),
        })
        .where(eq(meetingBotSessions.id, session.id));

      console.log(`[MeetingBaas Webhook] MP4 uploaded to R2: ${r2Key}`);
    } catch (r2Error) {
      // Non-fatal: MeetingBaas URL still works temporarily
      console.error('[MeetingBaas Webhook] R2 upload failed (MeetingBaas URL still available):', r2Error);
    }
  }

  // --- Deduct credits for meeting bot usage (via master DB) ---
  const durationMinutes = Math.ceil(duration / 60);
  if (durationMinutes > 0) {
    try {
      const masterDb = getMasterDb(env);

      // Resolve the master DB workspace ID from the Clerk orgId
      // workspaceId here is the Clerk orgId — look up the real workspace.id
      const [wsRecord] = await masterDb
        .select({ id: masterSchema.workspaces.id, planId: masterSchema.workspaces.planId })
        .from(masterSchema.workspaces)
        .where(eq(masterSchema.workspaces.clerkOrgId, workspaceId))
        .limit(1);

      if (!wsRecord) {
        console.warn('[MeetingBaas Webhook] Could not find workspace for credit deduction');
      } else {
        // Get credit rate from the workspace's plan
        let meetingBotRate = 2; // default
        if (wsRecord.planId) {
          const [plan] = await masterDb
            .select({ features: masterSchema.plans.features })
            .from(masterSchema.plans)
            .where(eq(masterSchema.plans.id, wsRecord.planId))
            .limit(1);
          const features = (plan?.features || {}) as {
            creditRates?: { meetingBotMinute?: number | null };
          };
          if (features.creditRates?.meetingBotMinute != null) {
            meetingBotRate = features.creditRates.meetingBotMinute;
          }
        }

        const creditsNeeded = durationMinutes * meetingBotRate;

        // Get current balance from master DB
        const [credits] = await masterDb
          .select()
          .from(masterSchema.workspaceCredits)
          .where(eq(masterSchema.workspaceCredits.workspaceId, wsRecord.id))
          .limit(1);

        if (credits && credits.currentBalance >= creditsNeeded) {
          const newBalance = credits.currentBalance - creditsNeeded;
          await masterDb
            .update(masterSchema.workspaceCredits)
            .set({
              currentBalance: newBalance,
              updatedAt: new Date(),
            })
            .where(eq(masterSchema.workspaceCredits.workspaceId, wsRecord.id));

          await masterDb.insert(masterSchema.creditTransactions).values({
            id: nanoid(),
            workspaceId: wsRecord.id,
            type: 'consumption',
            amount: -creditsNeeded,
            balanceAfter: newBalance,
            serviceType: 'meeting_bot',
            referenceId: session.id,
            referenceType: 'meeting_bot_session',
            description: `Meeting bot: ${durationMinutes} minutes`,
            metadata: {
              platform: session.platform,
              durationMinutes,
              meetingUrl: session.meetingUrl,
            },
          });

          console.log(`[MeetingBaas Webhook] Credits deducted: ${creditsNeeded} (${durationMinutes} min * ${meetingBotRate}/min) for session ${session.id}`);
        } else {
          console.warn(`[MeetingBaas Webhook] Insufficient credits for deduction (balance: ${credits?.currentBalance ?? 0}, needed: ${creditsNeeded})`);
        }
      }
    } catch (creditError) {
      console.warn('[MeetingBaas Webhook] Credit deduction failed:', creditError);
    }
  }

  // Store MeetingBaas transcript directly (free with meeting bot credits)
  if (session.enableTranscription && transcript && transcript.length > 0) {
    try {
      const { crmTranscriptions, crmTranscriptSegments } = schema;

      // Build full text from transcript segments
      const fullText = transcript
        .map((seg) => {
          const words = seg.words?.map((w) => w.word).join(' ') || '';
          return `${seg.speaker}: ${words}`;
        })
        .join('\n');

      const wordCount = fullText.split(/\s+/).filter((w) => w.length > 0).length;

      // Build speaker map for numeric IDs
      const speakerNames = [...new Set(transcript.map((seg) => seg.speaker))];
      const speakerMap = new Map(speakerNames.map((name, idx) => [name, idx]));

      // Create transcription record linked to the session's activity
      const transcriptionId = nanoid();
      await db.insert(crmTranscriptions).values({
        id: transcriptionId,
        activityId: session.activityId || session.id,
        status: 'completed',
        fullText,
        model: 'meetingbaas-native',
        provider: 'meetingbaas',
        language: session.language || 'en',
        wordCount,
        speakerCount: speakerNames.length,
        processingStartedAt: new Date(),
        processingCompletedAt: new Date(),
      });

      // Insert segments with speaker diarization
      const segmentRows = transcript.map((seg, index) => ({
        id: nanoid(),
        transcriptionId,
        speakerId: speakerMap.get(seg.speaker) ?? 0,
        speakerLabel: `Speaker ${(speakerMap.get(seg.speaker) ?? 0) + 1}`,
        speakerName: seg.speaker,
        text: seg.words?.map((w) => w.word).join(' ') || '',
        startTime: seg.start_time,
        endTime: seg.end_time,
        timestamp: formatTimestamp(seg.start_time),
        sequenceNumber: index,
      }));

      // Insert in batches of 100
      for (let i = 0; i < segmentRows.length; i += 100) {
        const batch = segmentRows.slice(i, i + 100);
        await db.insert(crmTranscriptSegments).values(batch);
      }

      console.log(`[MeetingBaas Webhook] Transcript stored: ${transcript.length} segments, ${speakerNames.length} speakers, ${wordCount} words`);
    } catch (transcriptError) {
      console.error('[MeetingBaas Webhook] Failed to store transcript:', transcriptError);
    }
  }

  await publishBotSessionEvent(env, db, workspaceId, 'completed', session.id, {
    ...session,
    ...updates,
  });
}

/**
 * Handle failed event
 */
export async function handleFailed(
  env: Env,
  payload: NormalizedMeetingBaasPayload,
): Promise<void> {
  console.log('[MeetingBaas Webhook] Processing failed event');

  const result = await findPlatformSession(env, payload);
  if (!result) {
    console.error('[MeetingBaas Webhook] Session not found for failed');
    return;
  }

  const { session, workspaceId } = result;
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const { meetingBotSessions } = schema;

  // Check nested data first, then top-level
  const errorMessage = payload.data?.message || payload.data?.error || payload.message || payload.error || 'Meeting bot failed';

  await db
    .update(meetingBotSessions)
    .set({
      status: 'failed',
      errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(meetingBotSessions.id, session.id));

  console.log(`[MeetingBaas Webhook] Session failed: ${session.id}`);

  await publishBotSessionEvent(env, db, workspaceId, 'updated', session.id, {
    ...session,
    status: 'failed',
    errorMessage,
  });
}
