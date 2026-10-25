/**
 * The WeldChat read boundary (`canAccessChannel`), with record chats
 * (`type = 'entity'`) following access to the record instead of membership
 * (ADR CHAT-003). Permissions are resolved from the tenant DB, as for any
 * caller that passes no `can` check (connect-api, background paths).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { canAccessChannel, canAccessMessage, unreadableRecordChatIds } from './channel-access';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

const now = () => new Date();

async function member(
  userId: string,
  opts: {
    role?: string;
    memberType?: string;
    permissions?: string[];
    permissionDenies?: string[];
  } = {},
): Promise<string> {
  const id = generateId('wm');
  await db.insert(schema.workspaceMembers).values({
    id,
    userId,
    email: `${userId}@example.com`,
    role: opts.role ?? 'MEMBER',
    memberType: opts.memberType ?? 'INTERNAL',
    permissions: opts.permissions ?? null,
    permissionDenies: opts.permissionDenies ?? null,
    status: 'ACTIVE',
    createdAt: now(),
    updatedAt: now(),
  } as typeof schema.workspaceMembers.$inferInsert);
  return id;
}

async function company(ownerId: string | null): Promise<string> {
  const id = generateId('cmp');
  await db.insert(schema.companies).values({
    id,
    name: id,
    displayName: id,
    ownerId,
    createdAt: now(),
    updatedAt: now(),
  } as unknown as typeof schema.companies.$inferInsert);
  return id;
}

async function channel(
  type: string,
  opts: { entityType?: string; entityId?: string; members?: string[] } = {},
): Promise<string> {
  const id = generateId('ch');
  await db.insert(schema.chatChannels).values({
    id,
    name: id,
    slug: id,
    type,
    entityType: opts.entityType ?? null,
    entityId: opts.entityId ?? null,
    createdAt: now(),
    updatedAt: now(),
  });
  for (const userId of opts.members ?? []) {
    await db.insert(schema.chatChannelMembers).values({ id: generateId('cmb'), channelId: id, userId });
  }
  return id;
}

async function message(channelId: string): Promise<string> {
  const id = generateId('msg');
  await db.insert(schema.chatMessages).values({
    id,
    channelId,
    authorId: 'u_author',
    authorName: 'Author',
    content: 'about the deal',
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

describe('canAccessChannel · record chats follow the record, not membership', () => {
  it('lets a colleague who may see the company read its chat without following it', async () => {
    await member('ra_admin', { role: 'ADMIN' });
    await member('ra_owner');
    const chat = await channel('entity', { entityType: 'company', entityId: await company('ra_owner'), members: [] });

    // ADMIN holds companies:read + companies:scope:all; the owner only companies:read.
    expect(await canAccessChannel(db, chat, 'ra_admin')).toBe(true);
    expect(await canAccessChannel(db, chat, 'ra_owner')).toBe(true);
  });

  it('refuses a follower who cannot see the record', async () => {
    // MEMBER: companies:read but not scope:all, and not the owner.
    await member('rb_follower');
    const chat = await channel('entity', {
      entityType: 'company',
      entityId: await company('rb_someone_else'),
      members: ['rb_follower'],
    });
    expect(await canAccessChannel(db, chat, 'rb_follower')).toBe(false);
  });

  it('refuses a follower who lost CRM access', async () => {
    const memberId = await member('rc_follower', { role: 'ADMIN' });
    const chat = await channel('entity', {
      entityType: 'company',
      entityId: await company(null),
      members: ['rc_follower'],
    });
    const msg = await message(chat);
    expect(await canAccessChannel(db, chat, 'rc_follower')).toBe(true);

    await db
      .update(schema.workspaceMembers)
      .set({ permissionDenies: ['companies:read'] })
      .where(eq(schema.workspaceMembers.id, memberId));
    expect(await canAccessChannel(db, chat, 'rc_follower')).toBe(false);
    expect(await canAccessMessage(db, msg, 'rc_follower')).toBe(false);
  });

  it('refuses a suspended or former workspace member', async () => {
    const memberId = await member('rd_gone', { role: 'OWNER' });
    const chat = await channel('entity', { entityType: 'company', entityId: await company(null), members: ['rd_gone'] });
    expect(await canAccessChannel(db, chat, 'rd_gone')).toBe(true);
    await db.update(schema.workspaceMembers).set({ status: 'SUSPENDED' }).where(eq(schema.workspaceMembers.id, memberId));
    expect(await canAccessChannel(db, chat, 'rd_gone')).toBe(false);
  });

  it('applies the same rule to guests: following is not enough', async () => {
    // A guest granted companies:read (no scope:all): sees only companies they own.
    await member('re_guest', { memberType: 'EXTERNAL_GUEST', role: 'VIEWER', permissions: ['companies:read'] });
    const chat = await channel('entity', {
      entityType: 'company',
      entityId: await company('re_someone_else'),
      members: ['re_guest'],
    });
    expect(await canAccessChannel(db, chat, 're_guest')).toBe(false);

    // The record they own: readable, following it or not.
    const theirs = await channel('entity', { entityType: 'company', entityId: await company('re_guest') });
    expect(await canAccessChannel(db, theirs, 're_guest')).toBe(true);

    // A guest on the bare VIEWER role has no companies:read: no company chat at all.
    await member('re_viewer_guest', { memberType: 'EXTERNAL_GUEST', role: 'VIEWER' });
    const owned = await channel('entity', {
      entityType: 'company',
      entityId: await company('re_viewer_guest'),
      members: ['re_viewer_guest'],
    });
    expect(await canAccessChannel(db, owned, 're_viewer_guest')).toBe(false);
  });

  it('closes the chat of a deleted record to everyone, the owner of the workspace included', async () => {
    await member('rf_owner', { role: 'OWNER' });
    const companyId = await company('rf_owner');
    const chat = await channel('entity', { entityType: 'company', entityId: companyId, members: ['rf_owner'] });
    expect(await canAccessChannel(db, chat, 'rf_owner')).toBe(true);
    await db.update(schema.companies).set({ deletedAt: now() }).where(eq(schema.companies.id, companyId));
    expect(await canAccessChannel(db, chat, 'rf_owner')).toBe(false);
  });

  it('closes a record chat whose type has no provider', async () => {
    await member('rg_owner', { role: 'OWNER' });
    const chat = await channel('entity', { entityType: 'customer', entityId: 'cus_1', members: ['rg_owner'] });
    expect(await canAccessChannel(db, chat, 'rg_owner')).toBe(false);
  });

  it('uses the caller-supplied permission check when given', async () => {
    const chat = await channel('entity', { entityType: 'company', entityId: await company(null) });
    // No workspace member row at all: only the supplied check decides.
    expect(await canAccessChannel(db, chat, 'rh_nobody', { can: async () => true })).toBe(true);
    expect(
      await canAccessChannel(db, chat, 'rh_nobody', { can: async (p) => p === 'companies:read' }),
    ).toBe(false);
  });

  it('leaves public, private and DM channels on membership', async () => {
    await member('ri_user');
    const pub = await channel('public');
    const priv = await channel('private', { members: ['ri_user'] });
    const otherPriv = await channel('private', { members: ['ri_other'] });
    const dm = await channel('dm', { members: ['ri_other', 'ri_third'] });
    expect(await canAccessChannel(db, pub, 'ri_user')).toBe(true);
    expect(await canAccessChannel(db, priv, 'ri_user')).toBe(true);
    expect(await canAccessChannel(db, otherPriv, 'ri_user')).toBe(false);
    expect(await canAccessChannel(db, dm, 'ri_user')).toBe(false);
  });
});

describe('unreadableRecordChatIds', () => {
  it('names only the record chats the user cannot read', async () => {
    await member('rj_user');
    const mine = await channel('entity', { entityType: 'company', entityId: await company('rj_user'), members: ['rj_user'] });
    const theirs = await channel('entity', { entityType: 'company', entityId: await company('rj_other'), members: ['rj_user'] });
    const unknown = await channel('entity', { entityType: 'customer', entityId: 'cus_2', members: ['rj_user'] });
    const priv = await channel('private', { members: ['rj_user'] });

    const unreadable = await unreadableRecordChatIds(db, 'rj_user', [mine, theirs, unknown, priv]);
    expect([...unreadable].sort()).toEqual([theirs, unknown].sort());
  });

  it('names every record chat of a type the user has no permission for', async () => {
    await member('rk_employee', { memberType: 'EMPLOYEE' });
    const chat = await channel('entity', { entityType: 'company', entityId: await company('rk_employee'), members: ['rk_employee'] });
    expect([...(await unreadableRecordChatIds(db, 'rk_employee', [chat]))]).toEqual([chat]);
  });
});
