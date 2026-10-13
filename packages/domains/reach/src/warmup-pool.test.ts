/**
 * Pool operations against a pglite master DB: what reach-api writes when a
 * mailbox is created, paused, resumed, renamed or deleted, and what it reads.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import {
  WarmupKeyMissingError,
  activePoolDomainCount,
  findWarmupMessageIds,
  openWarmupCredentials,
  pausePoolMailbox,
  readPoolMailboxes,
  registerPoolMailbox,
  removePoolMailbox,
  resumePoolMailbox,
  sealWarmupCredentials,
  unpausedStatus,
  updatePoolMailboxProfile,
  type RegisterPoolMailboxInput,
} from './warmup-pool';

const env = { WELDREACH_WARMUP_KEY: 'cd'.repeat(32) };
const pool = masterSchema.reachWarmupMailboxes;
const messages = masterSchema.reachWarmupMessages;

const smtp = { host: 'smtp.example.test', port: 465, tls: true, username: 'jane@getacme.com', password: 's3cret' };
const imap = { host: 'imap.example.test', port: 993, tls: true, username: 'jane@getacme.com', password: 's3cret' };

function input(overrides: Partial<RegisterPoolMailboxInput> = {}): RegisterPoolMailboxInput {
  return {
    workspaceId: 'ws_acme',
    clerkOrgId: 'org_acme',
    tenantMailboxId: 'rmbx_1',
    email: 'Jane@GetAcme.com',
    firstName: 'Jane',
    lastName: 'Doe',
    mailboxType: 'google',
    smtp,
    imap,
    ...overrides,
  };
}

let master: MasterDatabase;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await master.delete(messages);
  await master.delete(pool);
});

async function row(tenantMailboxId = 'rmbx_1') {
  const [found] = await master.select().from(pool).where(eq(pool.tenantMailboxId, tenantMailboxId));
  return found;
}

describe('credentials', () => {
  it('round-trips through the warmup key and refuses without it', async () => {
    const sealed = await sealWarmupCredentials(env, smtp);
    expect(sealed).not.toContain('s3cret');
    expect(await openWarmupCredentials(env, sealed)).toEqual(smtp);
    await expect(sealWarmupCredentials({}, smtp)).rejects.toBeInstanceOf(WarmupKeyMissingError);
    expect(await openWarmupCredentials({ WELDREACH_WARMUP_KEY: 'ef'.repeat(32) }, sealed)).toBeNull();
  });
});

describe('registerPoolMailbox', () => {
  it('adds the mailbox waiting, lower-cased, with sealed logins', async () => {
    await registerPoolMailbox(master, env, input());
    const r = await row();
    expect(r).toMatchObject({ email: 'jane@getacme.com', domain: 'getacme.com', status: 'waiting', rampDay: 0 });
    expect(await openWarmupCredentials(env, r!.imapCredentials)).toEqual(imap);
  });

  it('re-registering replaces logins and brings a removed mailbox back where it was', async () => {
    const { id } = await registerPoolMailbox(master, env, input());
    await master.update(pool).set({ startedAt: new Date(), rampDay: 5, status: 'warming' }).where(eq(pool.id, id));
    await removePoolMailbox(master, 'org_acme', 'rmbx_1');
    expect((await row())?.status).toBe('removed');

    const again = await registerPoolMailbox(master, env, input({ smtp: { ...smtp, password: 'new' } }));
    expect(again.id).toBe(id);
    const r = await row();
    expect(r?.status).toBe('warming');
    expect((await openWarmupCredentials(env, r!.smtpCredentials))?.password).toBe('new');
  });
});

describe('pause, resume, rename', () => {
  it('pauses with a reason and resumes to the right stage', async () => {
    const { id } = await registerPoolMailbox(master, env, input());
    await master.update(pool).set({ startedAt: new Date(), rampDay: 20, status: 'maintaining' }).where(eq(pool.id, id));

    await pausePoolMailbox(master, 'org_acme', 'rmbx_1', 'paused_by_user');
    expect(await row()).toMatchObject({ status: 'paused', pausedReason: 'paused_by_user' });

    await resumePoolMailbox(master, 'org_acme', 'rmbx_1');
    expect(await row()).toMatchObject({ status: 'maintaining', pausedReason: null });
  });

  it('leaves a staff pause in place when the workspace resumes', async () => {
    await registerPoolMailbox(master, env, input());
    await pausePoolMailbox(master, 'org_acme', 'rmbx_1', 'paused_by_staff');
    await resumePoolMailbox(master, 'org_acme', 'rmbx_1');
    expect(await row()).toMatchObject({ status: 'paused', pausedReason: 'paused_by_staff' });
  });

  it('keeps the sender name in step', async () => {
    await registerPoolMailbox(master, env, input());
    await updatePoolMailboxProfile(master, 'org_acme', 'rmbx_1', { firstName: 'Janet' });
    expect(await row()).toMatchObject({ firstName: 'Janet', lastName: 'Doe' });
  });

  it('unpausedStatus follows the warmup progress', () => {
    expect(unpausedStatus({ startedAt: null, rampDay: 0 })).toBe('waiting');
    expect(unpausedStatus({ startedAt: new Date(), rampDay: 3 })).toBe('warming');
    expect(unpausedStatus({ startedAt: new Date(), rampDay: 14 })).toBe('maintaining');
  });
});

describe('removePoolMailbox', () => {
  it('wipes the logins and cancels scheduled mail on both sides', async () => {
    const a = await registerPoolMailbox(master, env, input());
    const b = await registerPoolMailbox(master, env, input({ tenantMailboxId: 'rmbx_2', email: 'john@other.com' }));
    const base = { threadId: 'rwth_1', corpusThreadId: 'builtin-001', subject: 'Hi', scheduledAt: new Date() };
    await master.insert(messages).values([
      { ...base, id: 'rwms_1', fromMailboxId: a.id, toMailboxId: b.id, messageIdHeader: 'm1@getacme.com' },
      { ...base, id: 'rwms_2', fromMailboxId: b.id, toMailboxId: a.id, messageIdHeader: 'm2@other.com' },
      { ...base, id: 'rwms_3', fromMailboxId: a.id, toMailboxId: b.id, messageIdHeader: 'm3@getacme.com', status: 'sent' },
    ]);

    await removePoolMailbox(master, 'org_acme', 'rmbx_1');

    expect(await row()).toMatchObject({ status: 'removed', smtpCredentials: '', imapCredentials: '' });
    const after = await master.select().from(messages);
    const statusOf = (id: string) => after.find((m) => m.id === id)?.status;
    expect(statusOf('rwms_1')).toBe('failed');
    expect(statusOf('rwms_2')).toBe('failed');
    expect(statusOf('rwms_3')).toBe('sent');
  });
});

describe('reads', () => {
  it('lists a workspace without removed rows or logins, and counts active domains', async () => {
    await registerPoolMailbox(master, env, input());
    await registerPoolMailbox(master, env, input({ tenantMailboxId: 'rmbx_2', email: 'john@getacme.com' }));
    await registerPoolMailbox(master, env, input({ tenantMailboxId: 'rmbx_3', email: 'ann@acme-mail.com' }));
    await registerPoolMailbox(master, env, input({ clerkOrgId: 'org_other', tenantMailboxId: 'rmbx_9', email: 'x@third.com' }));
    await removePoolMailbox(master, 'org_acme', 'rmbx_3');

    const rows = await readPoolMailboxes(master, 'org_acme');
    expect(rows.map((r) => r.tenantMailboxId).sort()).toEqual(['rmbx_1', 'rmbx_2']);
    expect(rows[0]).not.toHaveProperty('smtpCredentials');
    expect(await activePoolDomainCount(master)).toBe(2);
  });

  it('finds warmup Message-IDs among others', async () => {
    const a = await registerPoolMailbox(master, env, input());
    await master.insert(messages).values({
      id: 'rwms_1',
      threadId: 'rwth_1',
      corpusThreadId: 'builtin-001',
      subject: 'Hi',
      scheduledAt: new Date(),
      fromMailboxId: a.id,
      toMailboxId: a.id,
      messageIdHeader: 'abc@getacme.com',
    });
    const found = await findWarmupMessageIds(master, [' abc@getacme.com ', 'real@prospect.com', '']);
    expect([...found]).toEqual(['abc@getacme.com']);
    expect((await findWarmupMessageIds(master, [])).size).toBe(0);
  });
});
