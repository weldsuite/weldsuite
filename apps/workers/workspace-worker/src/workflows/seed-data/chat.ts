/**
 * Chat default channels seeder.
 *
 * Seeds: #general and #random default channels with the workspace creator as owner.
 */

import { chatChannels } from '@weldsuite/db/schema/chat-channels';
import { chatChannelMembers } from '@weldsuite/db/schema/chat-channel-members';
import type { DrizzleDb, SeedContext } from './types';

export async function seedChatData(db: DrizzleDb, ctx: SeedContext): Promise<void> {
  // Idempotency: skip if channels already exist
  const existing = await db.select({ id: chatChannels.id }).from(chatChannels).limit(1);
  if (existing.length > 0) {
    console.log('[Seed:Chat] Channels already exist, skipping');
    return;
  }

  const { generateId, userId } = ctx;
  const now = new Date();

  const generalId = generateId('ch');
  const randomId = generateId('ch');

  // ── Default Channels ──────────────────────────────────────────────────
  await db.insert(chatChannels).values([
    {
      id: generalId,
      name: 'General',
      slug: 'general',
      description: 'Company-wide announcements and general discussion.',
      type: 'public',
      icon: '📢',
      createdBy: userId,
      isDefault: true,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: randomId,
      name: 'Random',
      slug: 'random',
      description: 'Watercooler chat, off-topic conversations, and fun stuff.',
      type: 'public',
      icon: '🎲',
      createdBy: userId,
      isDefault: true,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // ── Auto-join creator as owner ────────────────────────────────────────
  await db.insert(chatChannelMembers).values([
    {
      id: generateId('cmb'),
      channelId: generalId,
      userId,
      role: 'owner',
      joinedAt: now,
      createdAt: now,
    },
    {
      id: generateId('cmb'),
      channelId: randomId,
      userId,
      role: 'owner',
      joinedAt: now,
      createdAt: now,
    },
  ]);

  console.log('[Seed:Chat] Created default channels: #general, #random');
}
