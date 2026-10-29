import { z } from 'zod';

// `/api/canned-responses` — backed by `helpdesk_canned_responses`.

export const createCannedResponseSchema = z.object({
  name: z.string().min(1).max(255),
  subject: z.string().max(500).optional(),
  body: z.string(),
  shortcut: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  departmentId: z.string().nullish(),
  isShared: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateCannedResponseSchema = createCannedResponseSchema.partial();

export type CreateCannedResponseInput = z.infer<typeof createCannedResponseSchema>;
export type UpdateCannedResponseInput = z.infer<typeof updateCannedResponseSchema>;

/** A `helpdesk_canned_responses` row, as /api/canned-responses returns it. */
export const helpdeskCannedResponseSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    subject: z.string().nullable(),
    content: z.string(),
    category: z.string().nullable(),
    scope: z.string(),
    agentId: z.string().nullable(),
    teamId: z.string().nullable(),
    departmentId: z.string().nullable(),
    usageCount: z.number().nullable(),
    lastUsedAt: z.string().nullable(),
    shortcut: z.string().nullable(),
    keywords: z.unknown(),
    actions: z.unknown(),
    isActive: z.boolean(),
  })
  .passthrough();

/** One entry of `GET /api/canned-responses/categories`: a distinct category name. */
export const cannedResponseCategorySchema = z.string();

/** `POST /api/canned-responses/:id/use`: the response rendered with the caller's variables. */
export const cannedResponseUseResultSchema = z.object({
  content: z.string(),
  subject: z.string().nullable(),
  actions: z.array(z.unknown()),
});
