/**
 * Workspace presence: who is here, and what they want others to see.
 *
 * Two separate facts make up the status dot next to a member:
 *
 *  - **Live presence** — whether the member has a connection open right now,
 *    and whether anyone is at the keyboard. Only the WorkspaceHub Durable
 *    Object knows this: it holds every socket of the workspace. It is never
 *    written to Postgres. Clients get it as a `snapshot` on subscribing to the
 *    `presence` topic, then as `connection_changed` events; workers ask the hub
 *    (`RealtimePublisher.getPresence`).
 *  - **Chosen status** — what the member picked: Busy, Do not disturb, Away,
 *    Appear offline, or nothing (automatic), plus a custom text and emoji. It is
 *    a preference, so it lives in the tenant `chat_user_status` row and survives
 *    disconnects.
 *
 * `effectivePresence` combines the two into what everyone else sees.
 */

export const PRESENCE_TOPIC = 'presence';

/** Events on the `presence` topic. */
export const PRESENCE_EVENTS = {
  /** Hub → one subscriber: every connected member, sent on subscribe. */
  snapshot: 'snapshot',
  /** Hub → subscribers: one member's live presence changed (`live: null` = offline). */
  connection: 'connection_changed',
  /** chat-api → subscribers: a member changed their chosen status. */
  status: 'status_changed',
  /** chat-api → subscribers: a member cleared their chosen status. */
  cleared: 'status_cleared',
} as const;

/**
 * What the hub knows from a member's open connections. A member with no open
 * connection is absent from every map (offline).
 *
 *  - `online` — at least one connection has someone at the keyboard.
 *  - `away`   — connected, but every connection reports the user idle.
 *  - `busy`   — in a call on one of their connections.
 */
export type LivePresence = 'online' | 'away' | 'busy';

/**
 * What a member picked. `online` means "automatic" (no override): the dot
 * follows live presence. `offline` means "appear offline".
 */
export type ChosenStatus = 'online' | 'busy' | 'away' | 'dnd' | 'offline';

/** What other members see. */
export type EffectiveStatus = 'online' | 'busy' | 'away' | 'dnd' | 'offline';

/** Per-connection state a client reports to the hub. */
export interface ConnectionPresence {
  /** Nobody has touched this client for a while. */
  idle: boolean;
  /** This client is in a call. */
  inCall: boolean;
}

/** Payload of the `snapshot` event. */
export interface PresenceSnapshot {
  users: Record<string, LivePresence>;
}

/** Payload of the `connection_changed` event. */
export interface PresenceConnectionChange {
  userId: string;
  live: LivePresence | null;
}

/** Payload of the `status_changed` event. */
export interface PresenceStatusChange {
  userId: string;
  status: ChosenStatus;
  statusText?: string | null;
  statusEmoji?: string | null;
  expiresAt?: string | null;
  /** ISO time of the write — newer than any GET that came before it. */
  updatedAt?: string;
}

/**
 * Fold a member's open connections into one live presence. Busy beats online
 * beats away; no connections is offline (`null`).
 */
export function aggregateConnections(connections: readonly ConnectionPresence[]): LivePresence | null {
  if (connections.length === 0) return null;
  if (connections.some((c) => c.inCall)) return 'busy';
  if (connections.some((c) => !c.idle)) return 'online';
  return 'away';
}

/** What everyone else sees for a member. */
export function effectivePresence(
  chosen: ChosenStatus | null | undefined,
  live: LivePresence | null | undefined,
): EffectiveStatus {
  // Not connected anywhere: offline, whatever they picked. A chosen status is
  // about how to treat someone who is here.
  if (!live) return 'offline';
  if (chosen === 'offline' || chosen === 'dnd' || chosen === 'busy' || chosen === 'away') return chosen;
  return live;
}

// ---------------------------------------------------------------------------
// Storage mapping for `chat_user_status.status`
//
// Before presence moved into the hub, the same column also held live presence:
// the hub wrote `offline` when a member's last socket closed, and clients wrote
// `online`/`away` as they connected and idled. Those rows are still there, so a
// stored `online`, `offline` or `away` cannot mean a choice. Choices are
// therefore stored as values the old writers never used: `busy` and `dnd` (only
// ever written deliberately), `away_manual` and `invisible`.
// ---------------------------------------------------------------------------

const STORED_FOR_CHOICE: Record<ChosenStatus, string> = {
  online: 'online',
  busy: 'busy',
  dnd: 'dnd',
  away: 'away_manual',
  offline: 'invisible',
};

/** The `chat_user_status.status` value to store for a choice. */
export function storedStatusFor(chosen: ChosenStatus): string {
  return STORED_FOR_CHOICE[chosen];
}

/**
 * Read a `chat_user_status` row as a choice. A row whose status has expired
 * (`statusExpiresAt` in the past) is automatic again.
 */
export function chosenStatusFromStored(
  stored: string | null | undefined,
  expiresAt?: Date | string | null,
  now: number = Date.now(),
): ChosenStatus {
  if (expiresAt && new Date(expiresAt).getTime() <= now) return 'online';
  switch (stored) {
    case 'busy':
      return 'busy';
    case 'dnd':
      return 'dnd';
    case 'away_manual':
      return 'away';
    case 'invisible':
      return 'offline';
    default:
      // 'online', and the legacy 'offline'/'away' the old presence writers left.
      return 'online';
  }
}

/** Whether a row's custom text/emoji are still current. */
export function isStatusExpired(expiresAt: Date | string | null | undefined, now: number = Date.now()): boolean {
  return Boolean(expiresAt) && new Date(expiresAt as Date | string).getTime() <= now;
}
