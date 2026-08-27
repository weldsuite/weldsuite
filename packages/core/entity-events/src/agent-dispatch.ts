/**
 * Optional WeldAgent runner hook.
 *
 * app-api registers an implementation on boot so `publishEntityEvent` can
 * dispatch matching workspace agents without a dedicated queue binding.
 */

export interface WeldAgentEventPayload {
  workspaceId: string;
  userId: string;
  entityType: string;
  action: string;
  entityId: string;
  data: Record<string, unknown>;
  /** Opaque tenant DB handle from the publisher. */
  db: unknown;
  env: unknown;
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
