import { z } from 'zod';

/**
 * `/api/desk/teams` — WeldDesk v2 team inboxes + per-teammate inbox settings.
 *
 * See packages/db/src/schema/desk-teams.ts (deskTeams, deskTeammateSettings).
 * A team IS a team inbox (Intercom model), replacing helpdesk_departments.
 */

export const DESK_DISTRIBUTION_METHODS = ['manual', 'round_robin', 'balanced'] as const;
export const DESK_TEAMMATE_STATUSES = ['active', 'away', 'away_reassign'] as const;

// ---------------------------------------------------------------------------
// Teams CRUD
// ---------------------------------------------------------------------------

const weeklyHoursSchema = z.record(
  z.array(z.object({ start: z.string(), end: z.string() })),
);

export const createDeskTeamSchema = z.object({
  name: z.string().min(1).max(255),
  icon: z.string().max(20).optional(),
  memberIds: z.array(z.string().max(255)).default([]),
  distributionMethod: z.enum(DESK_DISTRIBUTION_METHODS).default('manual'),
  teamLimit: z.number().int().positive().nullish(),
  ignoreAwayStatus: z.boolean().optional(),
  officeHours: z
    .object({ timezone: z.string(), hours: weeklyHoursSchema })
    .nullish(),
  expectedReplyTime: z.string().max(20).optional(),
  inboxRank: z.number().int().optional(),
});

export const updateDeskTeamSchema = createDeskTeamSchema.partial();

export const listDeskTeamsQuerySchema = z.object({
  archived: z.coerce.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Teammate settings ("me")
// ---------------------------------------------------------------------------

export const updateTeammateSettingsSchema = z.object({
  status: z.enum(DESK_TEAMMATE_STATUSES).optional(),
  assignmentLimit: z.number().int().positive().nullish(),
  notificationPreferences: z.record(z.boolean()).optional(),
});

export type CreateDeskTeamInput = z.infer<typeof createDeskTeamSchema>;
export type UpdateDeskTeamInput = z.infer<typeof updateDeskTeamSchema>;
export type ListDeskTeamsQuery = z.infer<typeof listDeskTeamsQuerySchema>;
export type UpdateTeammateSettingsInput = z.infer<typeof updateTeammateSettingsSchema>;
