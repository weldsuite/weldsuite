/**
 * What panel-api puts on the `panel-maintenance` queue (docs/plans/weldpanel.md
 * "Privacy and GDPR", ADR PANEL-002) and apps/workers/panel-maintenance
 * consumes: the ids of a person erased from one project, queued once the
 * PanelProject object has dropped the profile and excluded the ids from every
 * query. The ids are the user id and every anonymous id linked to it
 * (`PanelErasure.erasedIds` in ./project-object). The consumer records them and
 * the weekly Iceberg rewrite removes the rows, after which it calls
 * `clearErased(ids)` on the project's object.
 *
 * Queues: `panel-maintenance-test` (test), `panel-maintenance` (production);
 * producer binding `PANEL_MAINTENANCE`.
 */

import { z } from 'zod';

export const panelEraseMessageSchema = z.object({
  type: z.literal('erase'),
  workspaceId: z.string().min(1).max(255),
  projectId: z.string().min(1).max(30),
  ids: z.array(z.string().min(1).max(255)).min(1).max(1000),
});

export type PanelEraseMessage = z.infer<typeof panelEraseMessageSchema>;

/** Most ids one message holds (a queue message is at most 128 KB); a bigger erasure is sent as several messages. */
export const PANEL_ERASE_MAX_IDS = 1000;

/** Splits `ids` into messages the consumer accepts. */
export function eraseMessages(input: { workspaceId: string; projectId: string; ids: string[] }): PanelEraseMessage[] {
  const unique = [...new Set(input.ids.filter((id) => id.length > 0))];
  const messages: PanelEraseMessage[] = [];
  for (let i = 0; i < unique.length; i += PANEL_ERASE_MAX_IDS) {
    messages.push({ type: 'erase', workspaceId: input.workspaceId, projectId: input.projectId, ids: unique.slice(i, i + PANEL_ERASE_MAX_IDS) });
  }
  return messages;
}
