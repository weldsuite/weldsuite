/**
 * The product feedback board: the answers of `/api/feature-requests`
 * (app-api), global across workspaces.
 */

import { z } from 'zod';

export const featureRequestTypeSchema = z.enum(['feature', 'bug', 'improvement']);

export const featureRequestStatusSchema = z.enum([
  'open',
  'under_review',
  'planned',
  'in_progress',
  'completed',
  'declined',
]);

/**
 * A request on the board, with whether the caller voted on it. The submitter's
 * email and id, the admin notes and the voters stay on the server.
 */
export const featureRequestSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: featureRequestTypeSchema,
  status: featureRequestStatusSchema,
  voteCount: z.number().int(),
  submitterName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  hasVoted: z.boolean(),
});

export type FeatureRequest = z.infer<typeof featureRequestSchema>;

/** The request just submitted, as stored (the submitter sees their own row). */
export const createdFeatureRequestSchema = featureRequestSchema.extend({
  submitterId: z.string(),
  submitterEmail: z.string(),
  adminNotes: z.string().nullable(),
  voters: z.array(z.string()).nullable(),
});

/** Board totals by status and type. */
export const featureRequestStatsSchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  underReview: z.number().int(),
  planned: z.number().int(),
  inProgress: z.number().int(),
  completed: z.number().int(),
  declined: z.number().int(),
  features: z.number().int(),
  bugs: z.number().int(),
  improvements: z.number().int(),
});

export type FeatureRequestStats = z.infer<typeof featureRequestStatsSchema>;

/** A toggled vote. */
export const featureRequestVoteSchema = z.object({
  voteCount: z.number().int(),
  voters: z.array(z.string()).nullable(),
  hasVoted: z.boolean(),
});

export type FeatureRequestVote = z.infer<typeof featureRequestVoteSchema>;
