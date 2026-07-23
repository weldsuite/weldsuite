import 'server-only';

import { eq, and, desc, lt, isNull } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from './db';

const { workspaces, plans } = masterSchema;
const { supportChannels, supportMessages } = schema;

export interface SupportChannelDTO {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  messageCount: number;
  memberCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  deletedAt: Date | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportWorkspace {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  clerkOrgId: string | null;
  isActive: boolean;
  createdAt: string;
  supportChannel: SupportChannelDTO | null;
}

export interface SupportMessageList {
  messages: (typeof supportMessages.$inferSelect)[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listEnterpriseWorkspaces(): Promise<SupportWorkspace[]> {
  const masterDb = getMasterDb();

  const enterpriseWorkspaces = await masterDb
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      imageUrl: workspaces.imageUrl,
      clerkOrgId: workspaces.clerkOrgId,
      isActive: workspaces.isActive,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .innerJoin(plans, eq(workspaces.planId, plans.id))
    .where(eq(plans.slug, 'enterprise'));

  const results: SupportWorkspace[] = [];
  for (const ws of enterpriseWorkspaces) {
    if (!ws.clerkOrgId) continue;

    let channel: typeof supportChannels.$inferSelect | null = null;
    try {
      const tenantDb = await getTenantDbForWorkspace(ws.clerkOrgId);
      const [row] = await tenantDb
        .select()
        .from(supportChannels)
        .where(eq(supportChannels.status, 'active'))
        .limit(1);
      channel = row || null;
    } catch {
      channel = null;
    }

    results.push({
      ...ws,
      createdAt: ws.createdAt.toISOString(),
      supportChannel: channel
        ? {
            ...channel,
            lastMessageAt: channel.lastMessageAt ? channel.lastMessageAt.toISOString() : null,
            createdAt: channel.createdAt.toISOString(),
            updatedAt: channel.updatedAt.toISOString(),
          }
        : null,
    });
  }

  results.sort((a, b) => {
    const aTime = a.supportChannel?.lastMessageAt
      ? new Date(a.supportChannel.lastMessageAt).getTime()
      : 0;
    const bTime = b.supportChannel?.lastMessageAt
      ? new Date(b.supportChannel.lastMessageAt).getTime()
      : 0;
    return bTime - aTime;
  });

  return results;
}

export async function listSupportMessages(
  orgId: string,
  options: { before?: string; limit?: number } = {},
): Promise<SupportMessageList> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const tenantDb = await getTenantDbForWorkspace(orgId);

  const [channel] = await tenantDb
    .select()
    .from(supportChannels)
    .where(eq(supportChannels.status, 'active'))
    .limit(1);

  if (!channel) {
    return { messages: [], hasMore: false, nextCursor: null };
  }

  const conditions = [
    eq(supportMessages.channelId, channel.id),
    isNull(supportMessages.deletedAt),
  ];

  if (options.before) {
    const [cursorMsg] = await tenantDb
      .select({ createdAt: supportMessages.createdAt })
      .from(supportMessages)
      .where(eq(supportMessages.id, options.before));

    if (cursorMsg) {
      conditions.push(lt(supportMessages.createdAt, cursorMsg.createdAt));
    }
  }

  const messages = await tenantDb
    .select()
    .from(supportMessages)
    .where(and(...conditions))
    .orderBy(desc(supportMessages.createdAt))
    .limit(limit + 1);

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  return {
    messages,
    hasMore,
    nextCursor: hasMore && messages.length > 0 ? messages[messages.length - 1]!.id : null,
  };
}
