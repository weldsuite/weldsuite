import { z } from 'zod';
import { DESK_CHANNELS, DESK_CONVERSATION_STATES, DESK_PRIORITIES, deskConversationSchema, deskMessageSchema } from './desk-conversations';

/**
 * Problem management on /api/desk/problems and
 * /api/desk/conversations/:id/problem (desk-api): a problem is the cause
 * behind one or more incidents (inbox conversations). Rows are written by
 * `@weldsuite/db/lib/desk-problems`.
 */

export const DESK_PROBLEM_STATUSES = ['open', 'investigating', 'known_error', 'resolved', 'closed'] as const;
export const DESK_PROBLEM_SHARE_VISIBILITIES = ['note', 'reply'] as const;

const shortText = z.string().trim().min(1).max(500);
const longText = z.string().max(20_000);

/** `?knownErrors=1` / `true`. */
const flag = z.enum(['1', '0', 'true', 'false']).transform((value) => value === '1' || value === 'true');

/** POST /api/desk/problems. */
export const createDeskProblemSchema = z.object({
  title: shortText,
  description: longText.nullable().optional(),
  priority: z.enum(DESK_PRIORITIES).nullable().optional(),
  assigneeId: z.string().min(1).max(255).nullable().optional(),
  departmentId: z.string().min(1).max(30).nullable().optional(),
  rootCause: longText.nullable().optional(),
  workaround: longText.nullable().optional(),
  status: z.enum(DESK_PROBLEM_STATUSES).optional(),
  /** Incidents to link right away. */
  conversationIds: z.array(z.string().min(1).max(30)).max(200).optional(),
});

/** PATCH /api/desk/problems/:id: omitted fields are left alone, null clears one. */
export const updateDeskProblemSchema = z
  .object({
    title: shortText.optional(),
    description: longText.nullable().optional(),
    status: z.enum(DESK_PROBLEM_STATUSES).optional(),
    priority: z.enum(DESK_PRIORITIES).nullable().optional(),
    assigneeId: z.string().min(1).max(255).nullable().optional(),
    departmentId: z.string().min(1).max(30).nullable().optional(),
    rootCause: longText.nullable().optional(),
    workaround: longText.nullable().optional(),
    resolution: longText.nullable().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), { message: 'Nothing to update' });

/** GET /api/desk/problems. `status` is comma-separated. */
export const listDeskProblemsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
      const statuses = parts.filter((part): part is (typeof DESK_PROBLEM_STATUSES)[number] =>
        (DESK_PROBLEM_STATUSES as readonly string[]).includes(part),
      );
      if (statuses.length !== parts.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown problem status' });
        return z.NEVER;
      }
      return statuses;
    }),
  knownErrors: flag.optional(),
  assigneeId: z.string().max(255).optional(),
  departmentId: z.string().max(30).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/desk/problems/:id/conversations. */
export const listDeskProblemConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** PUT /api/desk/conversations/:id/problem: link, replace, or `null` to unlink. */
export const setDeskConversationProblemSchema = z.object({
  problemId: z.string().min(1).max(30).nullable(),
});

/** POST /api/desk/problems/:id/share-workaround: the text defaults to the problem's workaround. */
export const shareDeskProblemWorkaroundSchema = z.object({
  body: z.string().trim().max(20_000).optional(),
  visibility: z.enum(DESK_PROBLEM_SHARE_VISIBILITIES),
});

// ── responses ────────────────────────────────────────────────────────────────

/** A `desk_problems` row. */
export const deskProblemSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    problemNumber: z.number().int(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(DESK_PROBLEM_STATUSES),
    priority: z.enum(DESK_PRIORITIES).nullable(),
    rootCause: z.string().nullable(),
    workaround: z.string().nullable(),
    resolution: z.string().nullable(),
    assigneeId: z.string().nullable(),
    departmentId: z.string().nullable(),
    articleId: z.string().nullable(),
    knownErrorAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    createdById: z.string().nullable(),
  })
  .strict();

/** GET /, GET /:id, POST /, PATCH /:id, POST /:id/article: the problem with its incident counts. */
export const deskProblemWithCountsSchema = deskProblemSchema.extend({
  incidentCount: z.number().int().nonnegative(),
  openIncidentCount: z.number().int().nonnegative(),
});

/** A problem as an incident's details panel shows it. */
export const deskProblemSummarySchema = z
  .object({
    id: z.string(),
    problemNumber: z.number().int(),
    title: z.string(),
    status: z.enum(DESK_PROBLEM_STATUSES),
    workaround: z.string().nullable(),
    rootCause: z.string().nullable(),
  })
  .strict();

/** A linked incident as the problem page lists it (the linked-tickets summary). */
export const deskProblemIncidentSchema = z
  .object({
    id: z.string(),
    conversationNumber: z.number().int(),
    title: z.string().nullable(),
    state: z.enum(DESK_CONVERSATION_STATES),
    channel: z.enum(DESK_CHANNELS),
    name: z.string().nullable(),
    email: z.string().nullable(),
    assigneeId: z.string().nullable(),
    isMajorIncident: z.boolean(),
  })
  .strict();

/** POST /: the new problem and the timeline entries written on its incidents. */
export const deskProblemCreatedSchema = z
  .object({
    problem: deskProblemWithCountsSchema,
    messages: z.array(deskMessageSchema),
  })
  .strict();

/** GET /conversations/:id/problem: the linked problem, or null. */
export const deskConversationProblemSchema = deskProblemSummarySchema.nullable();

/** PUT /conversations/:id/problem: the conversation, the problem now linked and the new timeline entries. */
export const deskConversationProblemChangeSchema = z
  .object({
    conversation: deskConversationSchema,
    problem: deskProblemSummarySchema.nullable(),
    messages: z.array(deskMessageSchema),
  })
  .strict();

/** POST /:id/share-workaround: on how many open incidents it was posted, and how many were left out by the cap. */
export const deskProblemShareSchema = z
  .object({
    visibility: z.enum(DESK_PROBLEM_SHARE_VISIBILITIES),
    delivered: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    conversationIds: z.array(z.string()),
  })
  .strict();

export type DeskProblemStatus = (typeof DESK_PROBLEM_STATUSES)[number];
export type CreateDeskProblemInput = z.infer<typeof createDeskProblemSchema>;
export type UpdateDeskProblemInput = z.infer<typeof updateDeskProblemSchema>;
export type DeskProblemResponse = z.infer<typeof deskProblemWithCountsSchema>;
export type DeskProblemSummaryResponse = z.infer<typeof deskProblemSummarySchema>;
export type DeskProblemIncidentResponse = z.infer<typeof deskProblemIncidentSchema>;
