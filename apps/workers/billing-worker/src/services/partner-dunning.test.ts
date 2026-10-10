import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';

const mocks = vi.hoisted(() => ({
  recomputePartnerStatus: vi.fn(),
  getPartner: vi.fn(),
  partnerBillingRecipients: vi.fn(),
  partnerIdsWithOpenStatements: vi.fn(),
  partnerWorkspaceOrgIds: vi.fn(),
  sendPartnerDunningEmail: vi.fn(),
}));

vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  recomputePartnerStatus: mocks.recomputePartnerStatus,
  getPartner: mocks.getPartner,
  partnerBillingRecipients: mocks.partnerBillingRecipients,
  partnerIdsWithOpenStatements: mocks.partnerIdsWithOpenStatements,
  partnerWorkspaceOrgIds: mocks.partnerWorkspaceOrgIds,
}));
vi.mock('./partner-mail', () => ({ sendPartnerDunningEmail: mocks.sendPartnerDunningEmail }));

const { runDunningSweep, sweepPartnerDunning } = await import('./partner-dunning');

const kvDelete = vi.fn(async () => undefined);
const env = { WORKSPACE_CACHE: { delete: kvDelete } } as unknown as Env;
const now = new Date('2026-12-01T02:17:00Z');
const dueAt = new Date('2026-10-31T00:00:00Z');

const statement = {
  id: 'pst_1',
  periodStart: new Date('2026-09-01T00:00:00Z'),
  totalDue: '1842.50',
  currency: 'USD',
  stripeInvoiceUrl: 'https://invoice.stripe.com/i/in_1',
};

function evaluation(stage: 'current' | 'past_due' | 'final_warning' | 'suspended', daysOverdue: number, changed: boolean) {
  const status = stage === 'current' ? 'active' : stage === 'suspended' ? 'suspended' : 'past_due';
  return {
    changed,
    previousStatus: changed ? (status === 'active' ? 'past_due' : 'active') : status,
    openStatements: [statement],
    state: {
      stage,
      status,
      daysOverdue,
      statementId: 'pst_1',
      dueAt,
      pastDueAfterDays: 14,
      readOnlyAfterDays: 30,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getPartner.mockResolvedValue({ id: 'ptr_a', name: 'Andes', country: 'BR' });
  mocks.partnerBillingRecipients.mockResolvedValue(['bill@andes.test', 'owner@andes.test']);
  mocks.partnerWorkspaceOrgIds.mockResolvedValue(['org_1']);
  mocks.sendPartnerDunningEmail.mockResolvedValue(true);
});

describe('sweepPartnerDunning', () => {
  it('emails billing contacts at day 14 and records that it did', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('past_due', 14, true));
    const { db, written } = createFakeDb({ selects: [[]] }); // not yet notified

    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);

    expect(result).toEqual({ statusChanged: true, emailed: true, failed: false });
    expect(mocks.sendPartnerDunningEmail).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        stage: 'past_due',
        to: ['bill@andes.test', 'owner@andes.test'],
        partnerName: 'Andes',
        amountDue: '1842.50',
        currency: 'USD',
        daysOverdue: 14,
        dueAt: '2026-10-31T00:00:00.000Z',
        // Read-only 30 days after the due date.
        readOnlyAt: '2026-11-30T00:00:00.000Z',
        invoiceUrl: 'https://invoice.stripe.com/i/in_1',
      }),
    );
    const audit = written('insert') as Array<{ action: string; details: Record<string, unknown> }>;
    expect(audit.map((a) => a.action)).toEqual(['partner.status.auto', 'dunning.notify']);
    expect(audit[1]!.details).toMatchObject({ statementId: 'pst_1', stage: 'past_due', recipients: 2 });
    // The partner's workspaces pick up the new status without waiting for the KV TTL.
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
  });

  it('sends the day-23 final warning even though the partner status stays past_due', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('final_warning', 23, false));
    const { db } = createFakeDb({ selects: [[]] });
    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);
    expect(result).toEqual({ statusChanged: false, emailed: true, failed: false });
    expect(mocks.sendPartnerDunningEmail.mock.calls[0]![1].stage).toBe('final_warning');
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('sends the day-30 read-only notice and drops the caches', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('suspended', 31, true));
    const { db } = createFakeDb({ selects: [[]] });
    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);
    expect(result.emailed).toBe(true);
    expect(mocks.sendPartnerDunningEmail.mock.calls[0]![1].stage).toBe('suspended');
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
  });

  it('does not mail twice for the same statement and stage (a re-run of the sweep)', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('past_due', 15, false));
    const { db } = createFakeDb({ selects: [[{ id: 'aae_1' }]] }); // already notified
    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);
    expect(result).toEqual({ statusChanged: false, emailed: false, failed: false });
    expect(mocks.sendPartnerDunningEmail).not.toHaveBeenCalled();
  });

  it('sends nothing while the partner is current, or while a staff pause holds the clock', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('current', 20, true));
    const { db } = createFakeDb();
    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);
    expect(result.emailed).toBe(false);
    expect(mocks.sendPartnerDunningEmail).not.toHaveBeenCalled();
    // The pause lifted a suspension: caches still drop.
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
  });

  it('retries the next day when the email transport fails, and does not record the notice', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('past_due', 14, false));
    mocks.sendPartnerDunningEmail.mockRejectedValue(new Error('Cloudflare Email: 503'));
    const { db, written } = createFakeDb({ selects: [[]] });
    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);
    expect(result).toEqual({ statusChanged: false, emailed: false, failed: true });
    expect(written('insert')).toEqual([]);
  });

  it('does not record a notice when the worker has no email transport', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(evaluation('past_due', 14, false));
    mocks.sendPartnerDunningEmail.mockResolvedValue(false);
    const { db, written } = createFakeDb({ selects: [[]] });
    const result = await sweepPartnerDunning(env, db, 'ptr_a', now);
    expect(result.emailed).toBe(false);
    expect(written('insert')).toEqual([]);
  });

  it('skips a partner that no longer exists', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue(null);
    const result = await sweepPartnerDunning(env, createFakeDb().db, 'ptr_gone', now);
    expect(result).toEqual({ statusChanged: false, emailed: false, failed: false });
  });
});

describe('runDunningSweep', () => {
  it('sweeps every partner with an unpaid statement and survives one failing', async () => {
    mocks.partnerIdsWithOpenStatements.mockResolvedValue(['ptr_a', 'ptr_b', 'ptr_c']);
    mocks.recomputePartnerStatus
      .mockResolvedValueOnce(evaluation('past_due', 14, true))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(evaluation('current', 0, false));
    const { db } = createFakeDb({ selects: [[]] });

    const result = await runDunningSweep(env, db, now);

    expect(result).toEqual({ partners: 3, statusChanged: 1, emailed: 1, failed: 1 });
  });
});
