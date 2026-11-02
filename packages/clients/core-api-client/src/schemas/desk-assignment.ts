import { z } from 'zod';

export const DESK_ASSIGNMENT_MODES = ['off', 'round_robin', 'balanced'] as const;

/** PUT /api/desk/assignment — the admin's roster and rules (not who is away). */
export const updateDeskAssignmentSchema = z.object({
  mode: z.enum(DESK_ASSIGNMENT_MODES),
  memberIds: z.array(z.string().min(1).max(255)).max(500),
  maxOpenPerMember: z.number().int().min(1).max(1000).nullable(),
});

/** POST /api/desk/assignment/away — the caller marks themselves away or back. */
export const setDeskAwaySchema = z.object({
  away: z.boolean(),
});

/** /api/desk/assignment answers: the rules, who is away, and where the caller stands. */
export const deskAssignmentStateSchema = z.object({
  mode: z.enum(DESK_ASSIGNMENT_MODES),
  memberIds: z.array(z.string()),
  awayMemberIds: z.array(z.string()),
  maxOpenPerMember: z.number().nullable(),
  me: z.object({ inRotation: z.boolean(), away: z.boolean() }),
});

export type UpdateDeskAssignmentInput = z.infer<typeof updateDeskAssignmentSchema>;
export type SetDeskAwayInput = z.infer<typeof setDeskAwaySchema>;
