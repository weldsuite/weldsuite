import { z } from 'zod';

// ============================================================================
// Meeting Bot Sessions — records a bot attendee joining an external meeting
// to capture audio for transcription and call intelligence.
//
// Backed by the `meeting_bot_sessions` table.
// Permission prefix: `activities:*`
// ============================================================================

export const createMeetingBotSessionSchema = z.object({
  meetingUrl: z.string().min(1),
  platform: z.string().optional(),
  title: z.string().optional(),
  enableTranscription: z.boolean().optional(),
  enableDiarization: z.boolean().optional(),
  language: z.string().optional(),
  contactId: z.string().nullish(),
  opportunityId: z.string().nullish(),
});

export const updateMeetingBotSessionSchema = z.object({
  status: z.string().optional(),
  errorMessage: z.string().optional(),
  joinedAt: z.string().optional(),
  leftAt: z.string().optional(),
  duration: z.number().optional(),
  participantCount: z.number().optional(),
  contactId: z.string().nullable().optional(),
  opportunityId: z.string().nullable().optional(),
  activityId: z.string().nullish(),
  externalBotInstanceId: z.string().nullish(),
  externalSessionId: z.string().nullish(),
  externalRecordingId: z.string().nullish(),
  recordingStorageUrl: z.string().optional(),
  recordingStorageKey: z.string().optional(),
  recordingFileSize: z.number().optional(),
  recordingDuration: z.number().optional(),
  title: z.string().optional(),
});

export type CreateMeetingBotSessionInput = z.infer<typeof createMeetingBotSessionSchema>;
export type UpdateMeetingBotSessionInput = z.infer<typeof updateMeetingBotSessionSchema>;
