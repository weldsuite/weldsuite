/**
 * Optional WeldAgent runner hook.
 *
 * Phase 5: app-api registers an implementation on boot; the entity-agents*
 * queue consumer calls {@link runRegisteredWeldAgentDispatch} (no longer
 * invoked from the publish path).
 */

export interface WeldAgentEventPayload {
  workspaceId: string;
  userId: string;
  entityType: string;
  action: string;
  entityId: string;
  data: Record<string, unknown>;
  /** Opaque tenant DB handle from the consumer. */
  db: unknown;
  env: unknown;
  /** Entity-event id (`evt_…`) for hub-retry idempotency. */
  eventId?: string;
}

export type WeldAgentEventRunner = (payload: WeldAgentEventPayload) => Promise<void>;

let runner: WeldAgentEventRunner | null = null;

export function registerWeldAgentEventRunner(fn: WeldAgentEventRunner | null): void {
  runner = fn;
}

export function getWeldAgentEventRunner(): WeldAgentEventRunner | null {
  return runner;
}

export async function runRegisteredWeldAgentDispatch(
  payload: WeldAgentEventPayload,
): Promise<void> {
  if (!runner) return;
  await runner(payload);
}
