/**
 * Session recording routes — mounted by ./index.ts BEFORE its generic /:id
 * CRUD handlers (registration order matters in Hono).
 *
 *   POST   /:id/recording/start        sessions:update   host / allowParticipantRecord; optional AI options
 *   POST   /:id/recording/stop         sessions:update
 *   POST   /:id/recording/ai-options   sessions:update   organizer or meetings:scope:all; wallet-gated
 *   GET    /:id/recording              recordings:read   state, durations, AI options (no file URLs)
 *   POST   /:id/recording/access       recordings:read   mints tokenized playback/download URLs
 *   DELETE /:id/recording              recordings:delete every part + transcript + summary
 *   POST   /:id/recording/transcribe   sessions:update + recordings:read   Whisper over the stored audio
 *   POST   /:id/recording/summarize    sessions:update   summary of an existing transcript
 *   GET    /:id/transcription          recordings:read
 *   GET    /:id/transcription/status   recordings:read
 *
 * Paid actions (ai-options, transcribe, summarize) are NOT behind meetings:read:
 * they spend the workspace's credits. Entity events are published by the
 * services (services/weldmeet/session-recording.ts), one per mutation.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  recordingAiOptionsSchema,
  startRecordingSchema,
  transcribeRecordingSchema,
} from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import type { Env, Variables } from '../../types';
import { error } from '@weldsuite/worker-kit/response';
import {
  deleteRecording,
  getRecordingAccess,
  getRecordingInfo,
  getSessionTranscription,
  getSessionTranscriptionStatus,
  setRecordingAiOptions,
  startRecording,
  stopRecording,
  summarizeRecording,
  transcribeRecording,
} from '../../services/weldmeet/session-recording';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Bodies on these routes are optional: a missing or empty body means `{}`. */
async function optionalJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

app.post('/:id/recording/start', requirePermission('sessions:update'), async (c) => {
  const parsed = startRecordingSchema.safeParse(await optionalJson(c));
  if (!parsed.success) return error.badRequest(c, 'Invalid recording options', parsed.error.flatten());
  try {
    return await startRecording(c, c.req.param('id'), parsed.data);
  } catch (err) {
    console.error('[meet-api/meeting-sessions] recording/start failed:', err);
    return error.internal(c, 'Failed to start recording');
  }
});

app.post('/:id/recording/stop', requirePermission('sessions:update'), async (c) => {
  try {
    return await stopRecording(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] recording/stop failed:', err);
    return error.internal(c, 'Failed to stop recording');
  }
});

app.post(
  '/:id/recording/ai-options',
  requirePermission('sessions:update'),
  zValidator('json', recordingAiOptionsSchema),
  async (c) => {
    try {
      return await setRecordingAiOptions(c, c.req.param('id'), c.req.valid('json'));
    } catch (err) {
      console.error('[meet-api/meeting-sessions] recording/ai-options failed:', err);
      return error.internal(c, 'Failed to update recording options');
    }
  },
);

app.get('/:id/recording', requirePermission('recordings:read'), async (c) => {
  try {
    return await getRecordingInfo(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] recording get failed:', err);
    return error.internal(c, 'Failed to get recording');
  }
});

app.post('/:id/recording/access', requirePermission('recordings:read'), async (c) => {
  try {
    return await getRecordingAccess(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] recording/access failed:', err);
    return error.internal(c, 'Failed to create recording access');
  }
});

app.delete('/:id/recording', requirePermission('recordings:delete'), async (c) => {
  try {
    return await deleteRecording(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] recording delete failed:', err);
    return error.internal(c, 'Failed to delete recording');
  }
});

app.post(
  '/:id/recording/transcribe',
  requirePermission('sessions:update'),
  requirePermission('recordings:read'),
  async (c) => {
    const parsed = transcribeRecordingSchema.safeParse(await optionalJson(c));
    if (!parsed.success) return error.badRequest(c, 'Invalid transcription options', parsed.error.flatten());
    try {
      return await transcribeRecording(c, c.req.param('id'), parsed.data);
    } catch (err) {
      console.error('[meet-api/meeting-sessions] recording/transcribe failed:', err);
      return error.internal(c, 'Failed to start transcription');
    }
  },
);

app.post('/:id/recording/summarize', requirePermission('sessions:update'), async (c) => {
  try {
    return await summarizeRecording(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] recording/summarize failed:', err);
    return error.internal(c, 'Failed to start the summary');
  }
});

app.get('/:id/transcription', requirePermission('recordings:read'), async (c) => {
  try {
    return await getSessionTranscription(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] transcription get failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

app.get('/:id/transcription/status', requirePermission('recordings:read'), async (c) => {
  try {
    return await getSessionTranscriptionStatus(c, c.req.param('id'));
  } catch (err) {
    console.error('[meet-api/meeting-sessions] transcription-status failed:', err);
    return error.internal(c, 'Failed to fetch transcription status');
  }
});

export const meetingSessionRecordingRoutes = app;
