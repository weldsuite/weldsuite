/**
 * WeldSuite meet-api — the WeldMeet (meetings, meeting sessions, messages,
 * waitlist, meeting-bot sessions, transcriptions, and the MeetingBaas and
 * Cloudflare RealtimeKit webhooks) module's API worker, plus the
 * TranscribeRecording workflow.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { meetingBotSessionsRoutes } from './routes/meeting-bot-sessions';
import { meetingMessagesRoutes } from './routes/meeting-messages';
import { meetingSessionsRoutes } from './routes/meeting-sessions';
import { meetingWaitlistRoutes } from './routes/meeting-waitlist';
import { meetingsRoutes } from './routes/meetings';
import { transcriptionsRoutes } from './routes/transcriptions';
import { webhooksCloudflareRealtimeRoutes } from './routes/webhooks-cloudflare-realtime';
import { webhooksMeetingBotRoutes } from './routes/webhooks-meeting-bot';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'meet-api' });

// MeetingBaas meeting-bot webhook — PUBLIC (server-to-server, no Clerk).
app.route('/api/webhooks/meeting-bot', webhooksMeetingBotRoutes);

// Cloudflare Realtime (RTK) webhook — PUBLIC. POST / verifies each delivery's
// `rtk-signature` (RSA-SHA256, RealtimeKit's published key) and drops repeats
// by `rtk-uuid`. POST /setup (re-)registers the webhook with Cloudflare per env
// and is operator-only (bearer CF_REALTIME_WEBHOOK_TOKEN).
app.route('/api/webhooks/cloudflare-realtime', webhooksCloudflareRealtimeRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/meeting-bot-sessions', meetingBotSessionsRoutes);
app.route('/api/meeting-messages', meetingMessagesRoutes);
app.route('/api/meeting-sessions', meetingSessionsRoutes);
app.route('/api/meeting-waitlist', meetingWaitlistRoutes);
app.route('/api/meetings', meetingsRoutes);
app.route('/api/transcriptions', transcriptionsRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// Meeting recording transcription, under the `transcribe-recording-v3*`
// names: app-api keeps `transcribe-recording-v2*` only while its in-flight
// instances drain.
export { TranscribeRecordingWorkflow } from '@weldsuite/meet-domain/workflows/transcribe-recording';

export default {
  fetch: app.fetch,
};
