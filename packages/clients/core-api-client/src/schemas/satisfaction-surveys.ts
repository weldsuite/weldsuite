import { z } from 'zod';

// `/api/satisfaction-surveys` — backed by `helpdesk_satisfaction_surveys`.

export const createSatisfactionSurveySchema = z.object({
  ticketId: z.string().nullish(),
  customerId: z.string().nullish(),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().optional(),
  status: z.string().max(20).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateSatisfactionSurveySchema = createSatisfactionSurveySchema.partial();

export type CreateSatisfactionSurveyInput = z.infer<typeof createSatisfactionSurveySchema>;
export type UpdateSatisfactionSurveyInput = z.infer<typeof updateSatisfactionSurveySchema>;

/** A `helpdesk_satisfaction_surveys` row, as /api/satisfaction-surveys returns it. */
export const satisfactionSurveySchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    ticketId: z.string(),
    customerId: z.string(),
    counterpartyId: z.string().nullable(),
    rating: z.number().nullable(),
    comment: z.string().nullable(),
    responses: z.unknown(),
    sentAt: z.string(),
    respondedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    status: z.string(),
    followUpRequired: z.boolean().nullable(),
    followUpNotes: z.string().nullable(),
  })
  .passthrough();
