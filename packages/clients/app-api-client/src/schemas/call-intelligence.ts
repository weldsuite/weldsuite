import { z } from 'zod';

// ============================================================================
// Call Intelligence — VoIP phone number management and call-level sub-resources
// (transcription, token, stats). The voipCalls CRUD surface lives in
// /api/calls; this module adds the complementary phone-number management,
// WebRTC token generation, call statistics, and call-transcription
// sub-resources.
//
// Backed by `voip_phone_numbers` + `crm_transcriptions` tables.
// Permission prefix: `activities:*`
// ============================================================================

export const createPhoneNumberSchema = z.object({
  provider: z.enum(['telnyx']).default('telnyx'),
  phoneNumber: z.string().min(1),
  formattedNumber: z.string().optional(),
  countryCode: z.string().min(1),
  numberType: z.string().optional(),
  status: z.string().default('active'),
  providerPhoneNumberId: z.string().nullish(),
  providerConnectionId: z.string().nullish(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  allowInbound: z.boolean().optional(),
  allowOutbound: z.boolean().optional(),
  enableRecording: z.boolean().optional(),
});

export const updatePhoneNumberSchema = z.object({
  displayName: z.string().nullable().optional(),
  status: z.string().optional(),
  isDefault: z.boolean().optional(),
  formattedNumber: z.string().optional(),
  allowInbound: z.boolean().optional(),
  allowOutbound: z.boolean().optional(),
  enableRecording: z.boolean().optional(),
  description: z.string().optional(),
});

export const createCallTranscriptionSchema = z.object({
  language: z.string().optional(),
});

/** Most people ids one GET /api/calls/contact-stats request may ask for. */
export const CONTACT_CALL_STATS_MAX_IDS = 100;

/** GET /api/calls/contact-stats?contactIds=a,b,c — people ids, comma-separated. */
export const contactCallStatsQuerySchema = z.object({
  contactIds: z
    .string()
    .transform((v) => [...new Set(v.split(',').map((id) => id.trim()).filter(Boolean))])
    .pipe(z.array(z.string().max(30)).min(1).max(CONTACT_CALL_STATS_MAX_IDS)),
});

export const contactCallStatsSchema = z.object({
  contactId: z.string(),
  totalCalls: z.number().int(),
  inboundCalls: z.number().int(),
  outboundCalls: z.number().int(),
  /** Seconds. */
  totalDuration: z.number().int(),
  lastCallAt: z.string().nullable(),
});

export type ContactCallStats = z.infer<typeof contactCallStatsSchema>;
export type CreatePhoneNumberInput = z.infer<typeof createPhoneNumberSchema>;
export type UpdatePhoneNumberInput = z.infer<typeof updatePhoneNumberSchema>;
export type CreateCallTranscriptionInput = z.infer<typeof createCallTranscriptionSchema>;
