import { z } from 'zod';

/**
 * WeldDesk's priority matrix: ITIL impact × urgency → priority
 * (`helpdesk_settings.tickets.priorityMatrix`). With it on, a conversation's
 * priority follows the grid whenever its impact or urgency changes.
 */

export const DESK_IMPACTS = ['low', 'medium', 'high'] as const;
export const DESK_URGENCIES = ['low', 'medium', 'high'] as const;
const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']);

/** One impact's row: urgency → priority. */
const priorityRowSchema = z.object({ low: PRIORITY, medium: PRIORITY, high: PRIORITY });

/** impact → urgency → priority. */
export const deskPriorityGridSchema = z.object({
  low: priorityRowSchema,
  medium: priorityRowSchema,
  high: priorityRowSchema,
});

/**
 * GET|PUT /api/helpdesk-settings/priority-matrix, and `priorityMatrix` in
 * GET /api/desk/conversations/attributes. PUT replaces the whole setting.
 */
export const deskPriorityMatrixSchema = z.object({
  enabled: z.boolean(),
  matrix: deskPriorityGridSchema,
});

export type DeskImpactValue = (typeof DESK_IMPACTS)[number];
export type DeskUrgencyValue = (typeof DESK_URGENCIES)[number];
export type DeskPriorityGridInput = z.infer<typeof deskPriorityGridSchema>;
export type DeskPriorityMatrixInput = z.infer<typeof deskPriorityMatrixSchema>;
