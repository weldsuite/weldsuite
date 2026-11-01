/**
 * Response shapes of meet-api (WeldMeet): meetings, their live sessions and
 * recordings, the in-meeting chat, the waiting room, CRM transcripts and the
 * video provider's webhook receiver.
 *
 * The platform and the meeting portal read these through the interfaces in
 * `@weldsuite/core-api-client/schemas/weldmeet` and `./weldmeet-recordings`;
 * these Zod schemas mirror them and what the routes actually answer (whole
 * Drizzle rows on reads, `{ id }` on generic writes), so the Rust backend's
 * answers are checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-meet.ts`).
 *
 * Timestamps are ISO strings, nullable where the column is.
 */

import { z } from 'zod';

const instant = z.string().datetime({ offset: true });
const nullableInstant = instant.nullable();
const nullableString = z.string().nullable();
const nullableBoolean = z.boolean().nullable();
const nullableInt = z.number().int().nullable();
const aiJobStatus = z.enum(['pending', 'processing', 'completed', 'failed']);
const recordingStatus = z.enum(['recording', 'processing', 'ready', 'failed', 'unavailable', 'deleted']);

/** `{ id }`: what a generic create or update answers. */
export const meetIdRefSchema = z.object({ id: z.string() });
/** `{ ok: true }`. */
export const meetOkSchema = z.object({ ok: z.literal(true) });

// ── meetings ────────────────────────────────────────────────────────────────

/** An attendee entry (members carry a `userId`, CRM people and bare emails don't). */
const meetingAttendeeSchema = z
  .object({
    userId: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

/** A `meetings` row. */
export const meetingRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: nullableString,
  calendarEventId: nullableString,
  organizerId: z.string(),
  attendees: z.array(meetingAttendeeSchema).nullable(),
  meetingType: z.string(),
  status: z.string(),
  accessType: z.string(),
  waitingRoom: nullableBoolean,
  allowRecording: nullableBoolean,
  maxParticipants: nullableInt,
  hostManagement: nullableBoolean,
  allowParticipantRecord: nullableBoolean,
  hostMustJoinFirst: nullableBoolean,
  autoEndInactivityMinutes: nullableInt,
  joinCode: nullableString,
  chatChannelId: nullableString,
  activeSessionId: nullableString,
  scheduledStart: nullableInstant,
  scheduledEnd: nullableInstant,
  isRecurring: nullableBoolean,
  recurrenceRule: nullableString,
  parentMeetingId: nullableString,
  tags: z.array(z.string()).nullable(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

const lastSessionParticipantSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  joinedAt: z.string(),
});

/** A list item: the row, its organizer and (`?include=lastSession`) its latest session. */
export const meetingListItemSchema = meetingRowSchema.extend({
  organizer: z.object({ userId: z.string(), name: z.string(), avatar: nullableString }).nullable(),
  lastSession: z
    .object({
      id: z.string(),
      status: z.string(),
      startedAt: nullableInstant,
      endedAt: nullableInstant,
      duration: nullableInt,
      recordingStatus: nullableString,
      participants: z.array(lastSessionParticipantSchema),
    })
    .nullable()
    .optional(),
});

/** `POST /api/meetings`. */
export const meetingCreatedSchema = z.object({ id: z.string(), joinCode: z.string() });

const participantSummarySchema = z.object({
  userId: z.string(),
  userName: z.string(),
  joinedAt: z.string(),
});

/** `POST /api/meetings/start-instant`. */
export const startInstantMeetingResultSchema = z.object({
  meetingId: z.string(),
  sessionId: z.string(),
  rtkMeetingId: z.string(),
  authToken: z.string(),
  joinCode: z.string(),
  participants: z.array(participantSummarySchema),
  timings: z.record(z.number()),
});

/** `POST /api/meetings/:id/invitations`. */
export const meetingInvitationsResultSchema = z.object({
  attendees: z.array(meetingAttendeeSchema),
  invited: z.array(z.object({ email: z.string(), name: z.string().optional(), emailSent: z.boolean() })),
  alreadyInvited: z.array(z.string()),
});

/** `PATCH /api/meetings/:id/host-controls`. */
export const meetingHostControlsSchema = z.object({
  hostManagement: nullableBoolean,
  allowScreenShare: nullableBoolean,
  allowMicrophone: nullableBoolean,
  allowVideo: nullableBoolean,
  allowHandRaise: nullableBoolean,
  allowReactions: nullableBoolean,
  allowAnnotations: nullableBoolean,
  allowVirtualBackgrounds: nullableBoolean,
  allowParticipantRecord: nullableBoolean,
  allowThirdPartyAccess: nullableBoolean,
  noiseCancellation: nullableBoolean,
  enableCaptions: nullableBoolean,
  autoRecord: nullableBoolean,
  hostMustJoinFirst: nullableBoolean,
  lockAfterStart: nullableBoolean,
  autoEndOnInactivity: nullableBoolean,
  autoEndInactivityMinutes: nullableInt,
});

/** `GET /api/meetings/recordings`: a recorded session, no file URL. */
export const recordingSummarySchema = z.object({
  sessionId: z.string(),
  meetingId: z.string(),
  recordingUrl: z.null(),
  recordingKey: z.null(),
  cfAppId: nullableString,
  recordingStatus: recordingStatus.nullable(),
  hasAudio: z.boolean(),
  hasTranscript: z.boolean(),
  hasSummary: z.boolean(),
  recordingDurationSeconds: nullableInt,
  recordingSizeBytes: z.number().nullable(),
  startedAt: nullableInstant,
  endedAt: nullableInstant,
  duration: nullableInt,
  maxParticipants: nullableInt,
  meetingTitle: z.string(),
  meetingType: z.string(),
});

/** `GET /api/meetings/ai-pricing`. */
export const meetingAiPricingSchema = z.object({
  transcriptionCreditsPerMinute: z.number().positive(),
  summaryCreditsPerMinute: z.number().positive(),
  balance: z.number(),
});

// ── sessions ────────────────────────────────────────────────────────────────

const sessionParticipantSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  joinedAt: z.string(),
  leftAt: z.string().optional(),
  cfSessionId: z.string().optional(),
  peerIds: z.array(z.string()).optional(),
});

const recordingPartSchema = z.object({
  rtkRecordingId: z.string(),
  status: z.enum(['recording', 'processing', 'ready', 'failed']),
});

/** A `meeting_sessions` row. */
export const meetingSessionRowSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  sessionType: z.string(),
  status: z.string(),
  cfAppId: nullableString,
  startedBy: z.string(),
  startedByName: z.string(),
  participants: z.array(sessionParticipantSchema).nullable(),
  startedAt: nullableInstant,
  endedAt: nullableInstant,
  duration: nullableInt,
  maxParticipants: z.number().int(),
  recordingEnabled: nullableBoolean,
  recordingUrl: nullableString,
  recordingKey: nullableString,
  rtkSessionId: nullableString,
  recordingStatus: nullableString,
  recordingSizeBytes: z.number().nullable(),
  recordingDurationSeconds: nullableInt,
  recordingReadyAt: nullableInstant,
  recordingError: nullableString,
  recordingParts: z.array(recordingPartSchema).nullable(),
  aiTranscribeRequested: nullableBoolean,
  aiSummarizeRequested: nullableBoolean,
  aiLanguage: nullableString,
  summaryStatus: nullableString,
  summaryText: nullableString,
  summaryGeneratedAt: nullableInstant,
  createdAt: instant,
  updatedAt: instant,
});

/** `GET /active`, `GET /latest`: the session, or null. */
export const meetingSessionOrNullSchema = meetingSessionRowSchema.nullable();

/** `POST /api/meeting-sessions/start`. */
export const startSessionResultSchema = z.object({
  sessionId: z.string(),
  status: z.enum(['waiting', 'active']),
  rtkMeetingId: z.string(),
  authToken: z.string().optional(),
  participants: z.array(sessionParticipantSchema).optional(),
});

/** `POST /:id/join`: the room, or the waiting answer when the host must be first. */
export const joinSessionResultSchema = z.union([
  z.object({ sessionId: z.string(), authToken: z.string(), participants: z.array(sessionParticipantSchema) }),
  z.object({ sessionId: z.string(), status: z.literal('waiting'), reason: z.literal('host_must_join_first') }),
]);

/** `POST /:id/participants/remove`. */
export const removeParticipantResultSchema = z.object({ ok: z.literal(true), kicked: z.boolean(), blocked: z.boolean() });

/** `GET /:id/recordings`: the video provider's listing next to the saved URL. */
export const sessionRecordingsResultSchema = z.object({
  recordings: z.array(z.object({ id: z.string() }).passthrough()),
  savedUrl: nullableString,
});

const aiChoiceSchema = z.object({ transcribe: z.boolean(), summarize: z.boolean(), language: nullableString });

/** `GET /:id/recording` (and the per-meeting alias, with the stream URLs). */
export const sessionRecordingInfoSchema = z.object({
  sessionId: z.string(),
  meetingId: z.string(),
  status: recordingStatus.nullable(),
  recording: z.boolean(),
  error: nullableString,
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  sizeBytes: z.number().nullable(),
  durationSeconds: nullableInt,
  readyAt: nullableInstant,
  parts: z.array(
    z.object({
      rtkRecordingId: z.string(),
      status: z.enum(['recording', 'processing', 'ready', 'failed']),
      hasVideo: z.boolean(),
      hasAudio: z.boolean(),
      sizeBytes: z.number().nullable(),
      durationSeconds: z.number().nullable(),
      startedAt: nullableString,
      stoppedAt: nullableString,
    }),
  ),
  ai: aiChoiceSchema,
  transcription: z.object({ exists: z.boolean(), id: z.string().optional(), status: aiJobStatus.optional(), source: z.string().optional() }),
  summary: z.object({ status: aiJobStatus.nullable(), source: nullableString, generatedAt: nullableInstant, error: nullableString }),
  transcriptionCreditsCharged: nullableInt,
  summaryCreditsCharged: nullableInt,
});

/** `GET /api/meetings/:id/recording`: null when never recorded, else the state and fresh URLs once ready. */
export const meetingRecordingSchema = sessionRecordingInfoSchema
  .extend({ duration: nullableInt, url: nullableString, audioUrl: nullableString, expiresAt: nullableInstant })
  .nullable();

/** `POST /:id/recording/access`. */
export const recordingAccessSchema = z.object({ url: z.string(), audioUrl: nullableString, expiresAt: instant });

/** `POST /:id/recording/ai-options`, `POST /:id/recording/start`. */
export const recordingAiOptionsResultSchema = z.object({ ok: z.literal(true), ai: aiChoiceSchema });

/** `DELETE /:id/recording`. */
export const deleteRecordingResultSchema = z.object({ ok: z.literal(true), deletedObjects: z.number().int().nonnegative() });

/** `POST /:id/recording/transcribe`. */
export const transcribeRecordingResultSchema = z.object({
  id: z.string(),
  status: z.union([aiJobStatus, z.literal('existing')]),
  message: z.string().optional(),
});

/** `POST /:id/recording/summarize`. */
export const summarizeRecordingResultSchema = z.object({
  status: z.enum(['processing', 'existing']),
  message: z.string().optional(),
});

const transcriptSegmentSchema = z.object({
  id: z.string(),
  speakerId: z.number().int(),
  speakerLabel: nullableString,
  text: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  sequenceNumber: z.number().int(),
  start: z.number(),
  end: z.number(),
  speaker: nullableString,
});

/** `GET /:id/transcription`. */
export const sessionTranscriptionSchema = z.object({
  id: z.string(),
  activityId: z.string(),
  status: z.string(),
  fullText: nullableString,
  provider: nullableString,
  model: nullableString,
  language: nullableString,
  speakerCount: nullableInt,
  wordCount: nullableInt,
  errorMessage: nullableString,
  segments: z.array(transcriptSegmentSchema),
  summary: nullableString,
  summaryStatus: aiJobStatus.nullable(),
});

/** `GET /:id/transcription/status`. */
export const sessionTranscriptionStatusSchema = z.union([
  z.object({ exists: z.literal(false), summaryStatus: aiJobStatus.nullable() }),
  z.object({
    exists: z.literal(true),
    id: z.string(),
    status: z.string(),
    errorMessage: nullableString,
    wordCount: nullableInt,
    speakerCount: nullableInt,
    summaryStatus: aiJobStatus.nullable(),
  }),
]);

// ── in-meeting chat ─────────────────────────────────────────────────────────

/** A `meeting_messages` row. */
export const meetingMessageRowSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  authorAvatar: nullableString,
  content: z.string(),
  type: z.string(),
  attachments: z.array(z.object({ id: z.string(), fileName: z.string(), url: z.string() }).passthrough()).nullable(),
  hasAttachments: z.boolean(),
  pinnedAt: nullableInstant,
  pinnedBy: nullableString,
  metadata: z.record(z.unknown()).nullable(),
  createdAt: instant,
  updatedAt: instant,
  deletedAt: nullableInstant,
});

const chatMessageSchema = meetingMessageRowSchema.extend({ htmlContent: nullableString });

/**
 * `GET /api/meeting-messages`: the generic list without `meetingId`, one
 * meeting's chat (`{ messages, hasMore, nextCursor }`) with it.
 */
export const meetingMessagesBodySchema = z.union([
  z.object({
    data: z.array(meetingMessageRowSchema),
    pagination: z.object({ totalCount: z.number().int(), hasMore: z.boolean(), cursor: nullableString }),
  }),
  z.object({ data: z.object({ messages: z.array(chatMessageSchema), hasMore: z.boolean(), nextCursor: nullableString }) }),
]);

/** `GET /api/meeting-messages/pinned`. */
export const pinnedMeetingMessagesSchema = z.object({ messages: z.array(meetingMessageRowSchema) });

/** `POST /api/meeting-messages`: the message as sent (no pin columns). */
export const sentMeetingMessageSchema = meetingMessageRowSchema
  .omit({ pinnedAt: true, pinnedBy: true })
  .extend({ htmlContent: nullableString, type: z.literal('message') });

/** `POST|DELETE /api/meeting-messages/:id/pin`. */
export const meetingMessagePinSchema = z.object({ pinned: z.boolean() });

// ── waiting room ────────────────────────────────────────────────────────────

/** A `meeting_session_waitlist` row. */
export const meetingWaitlistEntrySchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  sessionId: nullableString,
  name: z.string(),
  email: z.string(),
  status: z.string(),
  requestedAt: instant,
  decidedAt: nullableInstant,
  decidedBy: nullableString,
  createdAt: instant,
  updatedAt: instant,
});

// ── CRM transcripts ─────────────────────────────────────────────────────────

/** A `crm_transcript_segments` row. */
export const transcriptSegmentRowSchema = z.object({
  id: z.string(),
  transcriptionId: z.string(),
  speakerId: z.number().int(),
  speakerLabel: nullableString,
  speakerName: nullableString,
  text: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  sequenceNumber: z.number().int(),
  createdAt: instant,
});

/** `GET /api/transcriptions/:id`, `GET /by-activity/:activityId`: the row and its segments. */
export const transcriptionWithSegmentsSchema = z.object({
  id: z.string(),
  activityId: z.string(),
  status: z.string(),
  fullText: nullableString,
  language: nullableString,
  wordCount: nullableInt,
  speakerCount: nullableInt,
  errorMessage: nullableString,
  processingStartedAt: nullableInstant,
  processingCompletedAt: nullableInstant,
  createdAt: instant,
  updatedAt: instant,
  segments: z.array(transcriptSegmentRowSchema.extend({ start: z.number(), end: z.number(), speaker: nullableString })),
});

/** `GET /api/transcriptions/by-activity/:activityId/status`. */
export const transcriptionStatusSchema = z.union([
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    id: z.string(),
    status: z.string(),
    errorMessage: nullableString,
    processingStartedAt: nullableInstant,
    processingCompletedAt: nullableInstant,
    wordCount: nullableInt,
    speakerCount: nullableInt,
  }),
]);

/** `POST /api/transcriptions/:id/segments`. */
export const transcriptSegmentsAddedSchema = z.object({ count: z.number().int().nonnegative() });

// ── the video provider's webhooks (no envelope) ─────────────────────────────

/** `POST /api/webhooks/cloudflare-realtime`: `{ ok: true }` once accepted. */
export const rtkWebhookAckSchema = z.object({ ok: z.literal(true) });

/** `POST /api/webhooks/cloudflare-realtime/setup`. */
export const rtkWebhookSetupSchema = z.object({
  ok: z.literal(true),
  url: z.string().url(),
  id: z.string(),
  action: z.enum(['created', 'updated']),
  removedDuplicates: z.number().int().nonnegative(),
  events: z.array(z.string()),
});

/** `POST /api/webhooks/cloudflare-realtime/backfill-recordings`. */
export const rtkBackfillResultSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  workspaces: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  dispatched: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  perRunLimit: z.number().int().positive(),
  results: z.array(
    z.object({
      orgId: z.string(),
      candidates: z.number().int().nonnegative(),
      instanceId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
