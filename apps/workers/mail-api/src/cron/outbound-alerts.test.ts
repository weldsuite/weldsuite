/**
 * The outbound-alert sweep against a pglite master DB: new cases are mailed
 * once and stamped; nothing goes out without an address.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';

let master: MasterDatabase;
const sendSystemEmail = vi.fn();

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => master };
});
vi.mock('@weldsuite/emails', () => ({ sendSystemEmail: (...args: unknown[]) => sendSystemEmail(...args) }));
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => ({ send: vi.fn() }) }));

import { sendPendingOutboundAlerts } from './outbound-alerts';
import type { Env } from '../types';

const { outboundMailCases, workspaces } = masterSchema;

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db as MasterDatabase;
  await master.insert(workspaces).values({ id: 'ws_alert', name: 'Acme Studio', slug: 'acme-alert' });
}, 60_000);

beforeEach(async () => {
  sendSystemEmail.mockReset();
  await master.delete(outboundMailCases);
});

async function seedCase(id: string, createdAt = new Date()) {
  await master.insert(outboundMailCases).values({
    id,
    workspaceId: 'ws_alert',
    trigger: 'cold_outreach_template',
    severity: 'warning',
    fingerprint: '0123456789abcdef',
    subject: 'Quick question',
    snippet: 'hi tokname quick question',
    sampleDomains: ['x.com'],
    sources: ['crm_sequence'],
    metrics: { summary: 'A template was classified as cold outreach.', firstContactRecipients: 31, state: 'active' },
    dedupeKey: `k-${id}`,
    createdAt,
  });
}

const env = { ABUSE_NOTIFY_EMAIL: 'staff@weldsuite.org' } as unknown as Env;

describe('sendPendingOutboundAlerts', () => {
  it('mails each new case once and stamps it', async () => {
    await seedCase('obcase_1');
    expect(await sendPendingOutboundAlerts(env)).toBe(1);
    expect(sendSystemEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        template: 'internal.outbound-abuse-alert',
        to: 'staff@weldsuite.org',
        props: expect.objectContaining({
          workspaceName: 'Acme Studio',
          summary: 'A template was classified as cold outreach.',
          firstContactRecipients: 31,
          reviewUrl: 'https://admin.weldsuite.org/outbound-mail?case=obcase_1',
        }),
      }),
    );
    const [row] = await master.select().from(outboundMailCases).where(eq(outboundMailCases.id, 'obcase_1'));
    expect(row?.alertedAt).toBeInstanceOf(Date);
    expect(await sendPendingOutboundAlerts(env)).toBe(0);
  });

  it('skips cases older than a day and does nothing without an address', async () => {
    await seedCase('obcase_old', new Date(Date.now() - 2 * 86_400_000));
    expect(await sendPendingOutboundAlerts(env)).toBe(0);
    await seedCase('obcase_2');
    expect(await sendPendingOutboundAlerts({} as Env)).toBe(0);
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it('leaves a case un-stamped when the email fails, for the next run', async () => {
    await seedCase('obcase_3');
    sendSystemEmail.mockRejectedValueOnce(new Error('mail down'));
    expect(await sendPendingOutboundAlerts(env)).toBe(0);
    expect(await sendPendingOutboundAlerts(env)).toBe(1);
  });
});
