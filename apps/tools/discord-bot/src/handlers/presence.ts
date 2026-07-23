/**
 * Discord PRESENCE_UPDATE Handler
 *
 * Fires whenever a guild member's presence changes. We collapse Discord's
 * fine-grained statuses (online / idle / dnd / offline) into a coarse
 * "active" vs "away" signal and POST a webhook on every transition between
 * the two — so an external endpoint can record exactly when each person
 * came online and went offline.
 *
 *   "active" = online, idle, or dnd
 *   "away"   = offline (Discord reports `invisible` as `offline`, so it
 *              counts as away too)
 *
 * Flips that stay within "active" (e.g. online → idle) are ignored, so the
 * webhook only sees genuine online/offline transitions.
 *
 * Requires the GuildPresences (and GuildMembers, for reliable usernames)
 * privileged gateway intents — enabled in index.ts AND toggled on in the
 * Discord Developer Portal → Bot → Privileged Gateway Intents.
 */

import type { Presence, PresenceStatus } from 'discord.js';
import { getEnv } from '../lib/env.js';

const ACTIVE_STATUSES: ReadonlySet<PresenceStatus> = new Set(['online', 'idle', 'dnd']);

function isActive(status: PresenceStatus | undefined | null): boolean {
  return status ? ACTIVE_STATUSES.has(status) : false;
}

export async function handlePresenceUpdate(
  oldPresence: Presence | null,
  newPresence: Presence,
): Promise<void> {
  const { DISCORD_PRESENCE_WEBHOOK_URL: webhookUrl } = getEnv();
  // Feature is off until a webhook URL is configured.
  if (!webhookUrl) return;

  // Ignore bots (including ourselves).
  if (newPresence.user?.bot) return;

  const wasActive = isActive(oldPresence?.status);
  const nowActive = isActive(newPresence.status);

  // Only emit on a coarse active <-> away transition.
  if (wasActive === nowActive) return;

  const user = newPresence.user;
  const member = newPresence.member;
  const event = nowActive ? 'online' : 'offline';

  const payload = {
    event,
    userId: newPresence.userId,
    username: user?.username ?? null,
    displayName: member?.displayName ?? user?.displayName ?? user?.username ?? null,
    guildId: newPresence.guild?.id ?? null,
    guildName: newPresence.guild?.name ?? null,
    status: newPresence.status, // raw new status (online/idle/dnd/offline)
    previousStatus: oldPresence?.status ?? null,
    timestamp: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(
        `[Discord] Presence webhook responded ${res.status} for ${payload.displayName} (${event})`,
      );
      return;
    }

    console.log(`[Discord] Presence ${event}: ${payload.displayName} (${payload.userId})`);
  } catch (err) {
    // Best-effort — never crash the gateway on a webhook failure.
    console.error('[Discord] Failed to POST presence webhook:', err);
  }
}
