'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { getTenantDbForWorkspace, schema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { realtime } from '@/lib/realtime';
import type { listSupportMessages } from '@/lib/support-data';

const { supportChannels, supportMessages } = schema;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ReplyInput {
  orgId: string;
  content: string;
  authorName: string;
  authorAvatar?: string | null;
}

type SupportMessage = Awaited<ReturnType<typeof listSupportMessages>>['messages'][number];

export async function replyToSupport(input: ReplyInput): Promise<ActionResult<SupportMessage>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { userId } = guard.identity;

  const content = input.content?.trim();
  if (!content) return { ok: false, error: 'Message content is required.' };

  const tenantDb = await getTenantDbForWorkspace(input.orgId);

  const [channel] = await tenantDb
    .select()
    .from(supportChannels)
    .where(eq(supportChannels.status, 'active'))
    .limit(1);

  if (!channel) return { ok: false, error: 'Support channel not found' };

  const messageId = generateId('smsg');
  const preview = content.substring(0, 200);

  await tenantDb.insert(supportMessages).values({
    id: messageId,
    channelId: channel.id,
    authorId: userId,
    authorName: input.authorName,
    authorAvatar: input.authorAvatar ?? null,
    authorType: 'support',
    content,
  });

  await tenantDb
    .update(supportChannels)
    .set({
      lastMessageAt: new Date(),
      lastMessagePreview: preview,
      messageCount: channel.messageCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(supportChannels.id, channel.id));

  const [message] = await tenantDb
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.id, messageId));

  try {
    await realtime.supportEvent(input.orgId, 'message', message);
  } catch (err) {
    console.error('[admin/support reply] realtime publish failed:', err);
  }

  revalidatePath('/support');
  revalidatePath(`/support/${input.orgId}`);

  return { ok: true, data: message! };
}
