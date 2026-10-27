/**
 * Timing rules for the WorkspaceHub's live presence.
 *
 * The hub is the only place that knows who is connected (see
 * `@weldsuite/realtime/presence`). It learns that a connection is gone in two
 * ways:
 *
 *  - a close event — a tab closed, a reload, a client reconnecting. The member
 *    goes offline after `OFFLINE_GRACE_MS`, so a reload does not flicker;
 *  - silence — a laptop shut, a network dropped, a phone app suspended. No close
 *    frame ever arrives and the socket looks open. Clients send a heartbeat ping
 *    every 25 s, answered by the runtime's auto-response (which records when),
 *    so a socket that has not pinged for `STALE_CONNECTION_MS` is dead. A sweep
 *    every `PRESENCE_SWEEP_INTERVAL_MS` closes those.
 *
 * A browser may slow a hidden tab's timers to one run a minute, so the stale
 * limit leaves room for two of those before calling a connection dead.
 */

import type { ConnectionPresence } from '@weldsuite/realtime/presence';

/** Grace period after a member's last connection closes before they show offline. */
export const OFFLINE_GRACE_MS = 5_000;

/** A connection that has not been heard from for this long is dead. */
export const STALE_CONNECTION_MS = 120_000;

/** How often the hub looks for dead connections while anyone is connected. */
export const PRESENCE_SWEEP_INTERVAL_MS = 60_000;

/** Per-connection state, kept in the socket's attachment so it survives hibernation. */
export interface ConnectionState extends ConnectionPresence {
  connectedAt: number;
  /** Last message from the client other than an auto-answered ping. */
  lastSeen: number;
  /** Closed by the hub or the client; ignored until the runtime drops it. */
  gone?: boolean;
}

export function newConnectionState(now: number): ConnectionState {
  return { idle: false, inCall: false, connectedAt: now, lastSeen: now };
}

/**
 * When the client was last heard from: its last message, or its last
 * heartbeat ping (`autoResponseAt`, from `getWebSocketAutoResponseTimestamp`).
 */
export function lastHeardFrom(state: ConnectionState, autoResponseAt: Date | null): number {
  return Math.max(state.lastSeen, state.connectedAt, autoResponseAt?.getTime() ?? 0);
}

export function isConnectionStale(lastHeard: number, now: number): boolean {
  return now - lastHeard > STALE_CONNECTION_MS;
}
