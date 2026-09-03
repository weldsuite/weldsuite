/**
 * Presence gate for the email channel.
 *
 * Email is a catch-up channel, not a live one: someone sitting in the app does
 * not need mail telling them what is already on their screen. Slack and Discord
 * both solve this by holding the email back until the recipient has actually
 * been away for a bit, then only sending if the notification is still unread.
 * This module answers the first half of that — is the recipient here right now?
 *
 * Presence is read from `chat_user_status`, which the realtime-worker's
 * WorkspaceHub Durable Object maintains: it writes `offline` when the last
 * socket drops (after a grace timer, so a reload does not flap) and repairs the
 * row back to `online` on reconnect. That makes the table the one server-side
 * source of truth available to a worker that has no socket of its own.
 */

import { eq } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import type { Database } from './types';

/**
 * What the presence check says to do with a pending email.
 *
 * `present`  — recipient is connected; drop the email entirely.
 * `absent`   — recipient is away or gone; hold the email, then send if the
 *              notification is still unread when the delay elapses.
 * `suppress` — recipient asked not to be disturbed; drop the email, and unlike
 *              `present` do not reconsider it later either.
 */
export type EmailPresence = 'present' | 'absent' | 'suppress';

/**
 * Map a `chat_user_status.status` value onto an email decision.
 *
 * `busy` counts as present: it is a "in a meeting, still at my desk" marker set
 * by a connected client, so mail would arrive while they are looking at the
 * app. `away` counts as absent — it means idle at the keyboard, which is
 * exactly the case email exists to cover. `dnd` is the one status the user set
 * deliberately to mean "leave me alone", so it suppresses rather than defers.
 */
export function presenceFromStatus(status: string | null | undefined): EmailPresence {
  switch (status) {
    case 'online':
    case 'busy':
      return 'present';
    case 'dnd':
      return 'suppress';
    // 'away', 'offline', an unknown value, or no row at all: nobody is
    // watching, so email is the right channel. A user who has never connected
    // has no row, and must still be reachable by mail.
    default:
      return 'absent';
  }
}

/** Read the recipient's presence and translate it into an email decision. */
export async function resolveEmailPresence(db: Database, userId: string): Promise<EmailPresence> {
  try {
    const [row] = await db
      .select({ status: schema.chatUserStatus.status })
      .from(schema.chatUserStatus)
      .where(eq(schema.chatUserStatus.userId, userId))
      .limit(1);

    return presenceFromStatus(row?.status);
  } catch (err) {
    // Presence is an optimisation, not a gate on delivery. If the lookup
    // fails, fall back to the pre-existing behaviour of mailing the user
    // rather than silently swallowing a notification.
    console.error('[Notifications] Presence lookup failed, treating as absent:', err);
    return 'absent';
  }
}
