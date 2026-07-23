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
