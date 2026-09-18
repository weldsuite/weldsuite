/**
 * Catalog entity types intentionally absent from `platformSyncMap`.
 *
 * Phase 9 DoD: catalog − these omits ⊆ sync-map keys. Every omit needs a
 * one-line reason. Live hub sync must not invent a second bus for these —
 * they use ChatRoom / personal topics / imperative fetches by design.
 *
 * WeldPass secrets are not on the entity-events catalog at all (EXEMPT from
 * the bus) — there is nothing to omit here.
 */

export const PLATFORM_SYNC_MAP_INTENTIONAL_OMITS = {
  chat_channel:
    'WeldChat messages/membership live on ChatRoom DO, not WorkspaceHub entity topics',
  chat_message:
    'WeldChat messages live on ChatRoom DO; hub entity sync is not required',
  chat_call:
    'WeldChat calls use the chat room path, not hub entity invalidation',
  mail_subscription:
    'Unsubscribe telemetry only — no platform list/detail query cache',
  project_pipeline_stage:
    'WeldFlow kanban stage page fetches imperatively (no useQuery); CRM pipeline_stage covers CRM',
} as const satisfies Record<string, string>;

export type PlatformSyncMapIntentionalOmit =
  keyof typeof PLATFORM_SYNC_MAP_INTENTIONAL_OMITS;

/** Bare personal catalog topics that stay user-scoped on WorkspaceHub. */
export const PLATFORM_SYNC_MAP_PERSONAL_ONLY = [
  'notification',
] as const;
