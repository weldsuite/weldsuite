import { z } from 'zod';

// `/api/helpdesk-feedback` — backed by `helpdesk_feedback`.

export const createHelpdeskFeedbackSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  type: z.string().max(50).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  customerName: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskFeedbackSchema = createHelpdeskFeedbackSchema.partial();

export type CreateHelpdeskFeedbackInput = z.infer<typeof createHelpdeskFeedbackSchema>;
export type UpdateHelpdeskFeedbackInput = z.infer<typeof updateHelpdeskFeedbackSchema>;

/** A `helpdesk_feedback` row, as /api/helpdesk-feedback returns it. */
export const helpdeskFeedbackItemSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    type: z.string(),
    status: z.string(),
    priority: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    submitterId: z.string(),
    submitterName: z.string(),
    submitterEmail: z.string(),
    votes: z.number(),
    voters: z.unknown(),
    attachments: z.unknown(),
    comments: z.unknown(),
    assigneeId: z.string().nullable(),
    assigneeName: z.string().nullable(),
    estimatedCompletion: z.string().nullable(),
    completedAt: z.string().nullable(),
    rejectionReason: z.string().nullable(),
  })
  .passthrough();
