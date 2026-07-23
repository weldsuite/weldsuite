import { z } from 'zod';

/**
 * `/api/desk/macros` — WeldDesk v2 macros (saved replies + bundled actions).
 *
 * See packages/db/src/schema/desk-macros.ts (deskMacros, DeskMacroAction).
 * Replaces helpdesk_canned_responses. `apply-macro` (mounted on the
 * conversations route, see routes/desk-conversations/index.ts) executes a
 * macro's actions against a single conversation via the parts service.
 */

export const deskMacroActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_tag'), tag: z.string().min(1).max(100) }),
  z.object({ type: z.literal('remove_tag'), tag: z.string().min(1).max(100) }),
  z.object({
    type: z.literal('assign'),
    assigneeType: z.enum(['admin', 'team']),
    assigneeId: z.string().max(255),
  }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('snooze'), durationMinutes: z.number().int().positive() }),
  z.object({ type: z.literal('mark_priority'), priority: z.boolean() }),
  z.object({
    type: z.literal('set_attribute'),
    attributeId: z.string().min(1).max(255),
    value: z.unknown(),
  }),
  z.object({ type: z.literal('apply_sla'), slaId: z.string().max(30) }),
]);

export const createDeskMacroSchema = z.object({
  name: z.string().min(1).max(255),
  body: z.string().optional(),
  insertAs: z.enum(['reply', 'note']).default('reply'),
  actions: z.array(deskMacroActionSchema).default([]),
  teamIds: z.array(z.string().max(30)).nullish(),
});

export const updateDeskMacroSchema = createDeskMacroSchema.partial();

export const listDeskMacrosQuerySchema = z.object({
  archived: z.coerce.boolean().optional(),
  teamId: z.string().max(30).optional(),
});

export const applyMacroSchema = z.object({
  macroId: z.string().max(30),
});

export type DeskMacroActionInput = z.infer<typeof deskMacroActionSchema>;
export type CreateDeskMacroInput = z.infer<typeof createDeskMacroSchema>;
export type UpdateDeskMacroInput = z.infer<typeof updateDeskMacroSchema>;
export type ListDeskMacrosQuery = z.infer<typeof listDeskMacrosQuerySchema>;
export type ApplyMacroInput = z.infer<typeof applyMacroSchema>;
