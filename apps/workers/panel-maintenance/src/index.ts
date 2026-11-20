/**
 * WeldSuite panel-maintenance: WeldPanel's erasure and retention job
 * (weldsuite-documentation/plans/weldpanel.md "Privacy and GDPR", ADR PANEL-002).
 *
 * Basin SQL only reads, so removing rows from the Iceberg tables takes another
 * engine: a PyIceberg job in a Cloudflare Container (container/). This worker
 * drives it:
 *
 *   queue     `panel-maintenance`: panel-api queues the ids of an erased person
 *             here; they are recorded in the ledger (fast, nothing else)
 *   cron      weekly: starts PanelMaintenanceWorkflow, which hands the ledger
 *             and every project's retention to the container, waits for it,
 *             and releases the erased ids in the project objects
 *   fetch     none: no route, no public host
 */

import { eraseMessageSchema, LEDGER_NAME, type EraseMessage } from './messages';
import type { Env } from './env';

export { MaintenanceJob } from './container';
export { MaintenanceLedger } from './ledger';
export { PanelMaintenanceWorkflow } from './workflow';

/** Records each erasure in the ledger. A malformed message is dropped (retrying cannot fix it); a ledger failure is retried. */
export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const ledger = env.MAINTENANCE_LEDGER.get(env.MAINTENANCE_LEDGER.idFromName(LEDGER_NAME));
  for (const message of batch.messages) {
    const parsed = eraseMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      // Never the body: it holds person ids.
      console.error(`[panel-maintenance] dropping malformed message ${message.id}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      message.ack();
      continue;
    }
    try {
      await ledger.addErasure(parsed.data satisfies EraseMessage);
      message.ack();
    } catch (error) {
      console.error(`[panel-maintenance] could not record erasure ${message.id}: ${error instanceof Error ? error.message : String(error)}`);
      message.retry({ delaySeconds: 60 });
    }
  }
}

/** The workflow instance id of a run: one per UTC day, so a repeated trigger the same day starts nothing new. */
export function runIdFor(scheduledTime: number): string {
  return `maintenance-${new Date(scheduledTime).toISOString().slice(0, 10)}`;
}

export async function handleScheduled(controller: Pick<ScheduledController, 'scheduledTime'>, env: Env): Promise<string | null> {
  const id = runIdFor(controller.scheduledTime);
  try {
    await env.MAINTENANCE_WORKFLOW.create({ id, params: {} });
    return id;
  } catch (error) {
    // The same day's run already exists.
    if (error instanceof Error && /already|exists|duplicate/i.test(error.message)) {
      console.warn(`[panel-maintenance] ${id} already started`);
      return null;
    }
    throw error;
  }
}

export default {
  fetch: (_request: Request) => new Response('Not found', { status: 404 }),
  queue: handleQueue,
  scheduled: (controller: ScheduledController, env: Env) => handleScheduled(controller, env).then(() => undefined),
} satisfies ExportedHandler<Env>;
