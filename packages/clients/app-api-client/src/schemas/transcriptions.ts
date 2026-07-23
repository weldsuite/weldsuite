import { z } from 'zod';

// ============================================================================
// Transcriptions — CRM call/meeting transcripts linked to an activity or
// meeting bot session. Segments are stored separately in
// `crm_transcript_segments`.
//
// Backed by `crm_transcriptions` + `crm_transcript_segments` tables.
// Permission prefix: `activities:*`
// PII-sensitive: only return fullText to users with explicit permission.
// ============================================================================

export const createTranscriptionSchema = z.object({
  activityId: z.string().min(1),
  language: z.string().optional(),
});

export const updateTranscriptionSchema = z.object({
  status: z.string().optional(),
  fullText: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  language: z.string().optional(),
  speakerCount: z.number().optional(),
  wordCount: z.number().optional(),
  confidence: z.number().optional(),
  errorMessage: z.string().nullable().optional(),
  processingStartedAt: z.string().nullable().optional(),
  processingCompletedAt: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const createTranscriptSegmentsSchema = z.object({
  segments: z.array(
    z.object({
      speakerId: z.number(),
      speakerLabel: z.string().optional(),
      speakerName: z.string().optional(),
      text: z.string(),
      startTime: z.number(),
      endTime: z.number(),
      timestamp: z.string().optional(),
      confidence: z.number().optional(),
      sequenceNumber: z.number(),
    }),
  ),
});

export type CreateTranscriptionInput = z.infer<typeof createTranscriptionSchema>;
export type UpdateTranscriptionInput = z.infer<typeof updateTranscriptionSchema>;
export type CreateTranscriptSegmentsInput = z.infer<typeof createTranscriptSegmentsSchema>;
