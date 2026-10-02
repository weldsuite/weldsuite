/**
 * WeldSuite meet-api — the WeldMeet (meetings, meeting sessions, messages,
 * waitlist, transcriptions and the Cloudflare RealtimeKit webhook) module's
 * API worker, plus the recording
 * copy and meeting-AI workflows (RealtimeKit's own recorder, private R2).
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { meetingMessagesRoutes } from './routes/meeting-messages';
import { meetingSessionsRoutes } from './routes/meeting-sessions';
import { meetingWaitlistRoutes } from './routes/meeting-waitlist';
import { meetingsRoutes } from './routes/meetings';
import { publicMeetingRecordingsRoutes } from './routes/public-meeting-recordings';
import { transcriptionsRoutes } from './routes/transcriptions';
import { webhooksCloudflareRealtimeRoutes } from './routes/webhooks-cloudflare-realtime';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'meet-api' });

// Cloudflare Realtime (RTK) webhook — PUBLIC. POST / verifies each delivery's
// `rtk-signature` (RSA-SHA256, RealtimeKit's published key) and drops repeats
// by `rtk-uuid`. POST /setup (re-)registers the webhook with Cloudflare per env
// and is operator-only (bearer CF_REALTIME_WEBHOOK_TOKEN).
app.route('/api/webhooks/cloudflare-realtime', webhooksCloudflareRealtimeRoutes);

// Tokenized recording streaming — PUBLIC (the KV token from POST
// /api/meeting-sessions/:id/recording/access is the credential; Range supported).
app.route('/public/meeting-recordings', publicMeetingRecordingsRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/meeting-messages', meetingMessagesRoutes);
app.route('/api/meeting-sessions', meetingSessionsRoutes);
app.route('/api/meeting-waitlist', meetingWaitlistRoutes);
app.route('/api/meetings', meetingsRoutes);
app.route('/api/transcriptions', transcriptionsRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// CopyMeetingRecording moves a finished RealtimeKit recording into the private
// MEETING_RECORDINGS bucket; MeetingAi ingests RealtimeKit's transcript/summary,
// runs Whisper over stored audio and summarizes.
export { BackfillLegacyRecordingsWorkflow } from '@weldsuite/meet-domain/workflows/backfill-legacy-recordings';
export { CopyMeetingRecordingWorkflow } from '@weldsuite/meet-domain/workflows/copy-meeting-recording';
export { MeetingAiWorkflow } from '@weldsuite/meet-domain/workflows/meeting-ai';
// RETIRED stub (AssemblyAI is gone), kept for ONE release because the registered
// `transcribe-recording-v3*` workflow still points at this class. Remove it, then
// `wrangler workflows delete` the registration.
export { TranscribeRecordingWorkflow } from '@weldsuite/meet-domain/workflows/transcribe-recording';

export default {
  fetch: app.fetch,
};
