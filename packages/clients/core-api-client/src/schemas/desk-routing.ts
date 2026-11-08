import { z } from 'zod';
import { DESK_CHANNELS } from './desk-conversations';

/**
 * `/api/desk/routing` — WeldDesk routing rules, kept in
 * `helpdesk_settings.automation.deskRouting` (`@weldsuite/db/lib/desk-routing`).
 * Ordered: the first enabled rule whose conditions all hold applies when a
 * conversation opens, and again when its type or tags change.
 */

export const DESK_ROUTING_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const id = (max: number) => z.string().min(1).max(max);
const tag = z.string().min(1).max(50);

export const deskRoutingConditionsSchema = z.object({
  channels: z.array(z.enum(DESK_CHANNELS)).max(10).optional(),
  ticketTypeIds: z.array(id(30)).max(50).optional(),
  /** Any of these tags. */
  tags: z.array(tag).max(50).optional(),
  priorities: z.array(z.enum(DESK_ROUTING_PRIORITIES)).max(4).optional(),
  departmentIds: z.array(id(30)).max(50).optional(),
});

export const deskRoutingActionsSchema = z.object({
  departmentId: id(30).nullable().optional(),
  assigneeId: id(255).nullable().optional(),
  priority: z.enum(DESK_ROUTING_PRIORITIES).nullable().optional(),
  addTags: z.array(tag).max(20).optional(),
});

export const deskRoutingRuleSchema = z.object({
  id: id(64),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  conditions: deskRoutingConditionsSchema,
  actions: deskRoutingActionsSchema,
});

/** PUT /api/desk/routing — the whole ordered list. */
export const updateDeskRoutingSchema = z.object({
  rules: z.array(deskRoutingRuleSchema).max(100),
});

/** /api/desk/routing answers: the rules as stored (normalised: empty lists and unset actions left out). */
export const deskRoutingStateSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      conditions: z.object({
        channels: z.array(z.string()).optional(),
        ticketTypeIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        priorities: z.array(z.string()).optional(),
        departmentIds: z.array(z.string()).optional(),
      }),
      actions: z.object({
        departmentId: z.string().optional(),
        assigneeId: z.string().optional(),
        priority: z.string().optional(),
        addTags: z.array(z.string()).optional(),
      }),
    }),
  ),
});

export type DeskRoutingRuleInput = z.infer<typeof deskRoutingRuleSchema>;
export type UpdateDeskRoutingInput = z.infer<typeof updateDeskRoutingSchema>;
export type DeskRoutingState = z.infer<typeof deskRoutingStateSchema>;
