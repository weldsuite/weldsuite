/**
 * Presence gate for the email channel.
 *
 * Email is a catch-up channel, not a live one: someone sitting in the app does
 * not need mail telling them what is already on their screen. Slack and Discord
 * both solve this by holding the email back until the recipient has actually
 * been away for a bit, then only sending if the notification is still unread.
 * This module answers the first half of that — is the recipient here right now?
 *
 * Two facts decide it (`@weldsuite/realtime/presence`): whether the recipient
 * has a connection open and is at the keyboard, which only the realtime
 * WorkspaceHub knows and is asked over the REALTIME binding; and the status
 * they chose, stored in `chat_user_status` — Do not disturb suppresses mail.
 */

import { eq } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { chosenStatusFromStored, type ChosenStatus, type LivePresence } from '@weldsuite/realtime/presence';
import type { Database, RealtimeBinding } from './types';

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

/** Where to ask the WorkspaceHub who is connected. */
export interface LivePresenceSource {
  realtime: RealtimeBinding | undefined;
  /** The caller's `REALTIME_INTERNAL_SECRET`. */
  realtimeSecret: string | undefined;
  workspaceId: string;
}

/**
 * Map a recipient's chosen status and live presence onto an email decision.
 *
 * Do not disturb is the one status chosen to mean "leave me alone", so it
 * suppresses rather than defers. Otherwise the recipient is present while
 * connected and active — in a call included, they are at their desk — and
 * absent when not connected, idle, or having said they are away: exactly the
 * cases email exists to cover.
 */
export function emailPresenceFor(chosen: ChosenStatus, live: LivePresence | null | undefined): EmailPresence {
  if (chosen === 'dnd') return 'suppress';
  if (!live || live === 'away' || chosen === 'away') return 'absent';
  return 'present';
}

/** Read the recipient's presence and translate it into an email decision. */
export async function resolveEmailPresence(
  db: Database,
  userId: string,
  source?: LivePresenceSource,
): Promise<EmailPresence> {
  try {
    const [row] = await db
      .select({ status: schema.chatUserStatus.status, expiresAt: schema.chatUserStatus.statusExpiresAt })
      .from(schema.chatUserStatus)
      .where(eq(schema.chatUserStatus.userId, userId))
      .limit(1);
    const chosen = chosenStatusFromStored(row?.status, row?.expiresAt);
    if (chosen === 'dnd' || !source?.realtime) return emailPresenceFor(chosen, null);

    const rt = new RealtimePublisher(source.realtime, { internalSecret: source.realtimeSecret });
    const live = await rt.getPresence(source.workspaceId, [userId]);
    return emailPresenceFor(chosen, live[userId]);
  } catch (err) {
    // Presence is an optimisation, not a gate on delivery. If the lookup
    // fails, fall back to mailing the user rather than silently swallowing a
    // notification.
    console.error('[Notifications] Presence lookup failed, treating as absent:', err);
    return 'absent';
  }
}
