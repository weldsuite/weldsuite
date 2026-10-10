import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';

const mocks = vi.hoisted(() => ({
  getPartner: vi.fn(),
  markStatementPaidByInvoice: vi.fn(),
  recomputePartnerStatus: vi.fn(),
  partnerWorkspaceOrgIds: vi.fn(),
  buildStatement: vi.fn(),
  saveStatement: vi.fn(),
  createPartnerDraftInvoice: vi.fn(),
  createPartnerInvoiceItem: vi.fn(),
  finalizePartnerInvoice: vi.fn(),
  sendPartnerInvoice: vi.fn(),
  retrievePartnerInvoice: vi.fn(),
  deletePartnerDraftInvoice: vi.fn(),
  voidPartnerInvoice: vi.fn(),
}));

vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  getPartner: mocks.getPartner,
  markStatementPaidByInvoice: mocks.markStatementPaidByInvoice,
  recomputePartnerStatus: mocks.recomputePartnerStatus,
  partnerWorkspaceOrgIds: mocks.partnerWorkspaceOrgIds,
  buildStatement: mocks.buildStatement,
  saveStatement: mocks.saveStatement,
}));
vi.mock('../lib/stripe-partner', () => ({
  createPartnerDraftInvoice: mocks.createPartnerDraftInvoice,
  createPartnerInvoiceItem: mocks.createPartnerInvoiceItem,
  finalizePartnerInvoice: mocks.finalizePartnerInvoice,
  sendPartnerInvoice: mocks.sendPartnerInvoice,
  retrievePartnerInvoice: mocks.retrievePartnerInvoice,
  deletePartnerDraftInvoice: mocks.deletePartnerDraftInvoice,
  voidPartnerInvoice: mocks.voidPartnerInvoice,
}));

const {
  handlePartnerInvoicePaid,
  handlePartnerInvoiceVoided,
  invoiceStatement,
  parsePeriod,
  runPartnerStatement,
  statementInvoiceItems,
  voidPartnerStatement,
} = await import('./partner-billing');
const { AdminBillingError } = await import('./admin-billing');

const kvDelete = vi.fn(async () => undefined);
const env = { STRIPE_SECRET_KEY: 'sk_test_x', WORKSPACE_CACHE: { delete: kvDelete } } as unknown as Env;

const partner = { id: 'ptr_a', name: 'Andes', billingEmail: 'bill@andes.test', stripeCustomerId: 'cus_partner', country: 'BR', legalName: null };

function statementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pst_1',
    partnerId: 'ptr_a',
    periodStart: new Date('2026-10-01T00:00:00Z'),
    periodEnd: new Date('2026-11-01T00:00:00Z'),
    currency: 'USD',
    status: 'final',
    totalResale: '500.00',
    totalDue: '372.00',
    totalMargin: '128.00',
    stripeInvoiceId: null,
    stripeInvoiceUrl: null,
    stripeInvoicePdf: null,
    dueAt: null,
    paidAt: null,
    contractSnapshot: { paymentTermsDays: 30 },
    ...overrides,
  };
}

const lines = [
  { workspaceName: 'Acme', daysActive: 31, daysInPeriod: 31, due: '300.00', extraCreditsAmount: '0.00' },
  { workspaceName: 'Beta', daysActive: 15, daysInPeriod: 31, due: '72.00', extraCreditsAmount: '12.00' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.getPartner.mockResolvedValue(partner);
  mocks.partnerWorkspaceOrgIds.mockResolvedValue(['org_1', 'org_2']);
  mocks.createPartnerDraftInvoice.mockResolvedValue({ id: 'in_draft', status: 'draft', amount_due: 0, currency: 'usd' });
  mocks.createPartnerInvoiceItem.mockResolvedValue({ id: 'ii_1' });
  mocks.finalizePartnerInvoice.mockResolvedValue({
    id: 'in_draft',
    status: 'open',
    amount_due: 37200,
    total: 37200,
    currency: 'usd',
    due_date: 1_795_000_000,
    hosted_invoice_url: 'https://invoice.stripe.com/i/in_draft',
    invoice_pdf: 'https://invoice.stripe.com/i/in_draft/pdf',
  });
  mocks.sendPartnerInvoice.mockResolvedValue({ id: 'in_draft', status: 'open', amount_due: 37200, currency: 'usd' });
});

describe('parsePeriod', () => {
  it('reads YYYY-MM as the UTC calendar month', () => {
    expect(parsePeriod('2026-02')).toEqual({ start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') });
    expect(parsePeriod('2026-12')?.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
  it('rejects anything else', () => {
    for (const bad of ['2026-13', '2026-00', '26-10', '2026-1', '', undefined, 'last month', '2019-12']) {
      expect(parsePeriod(bad as string | undefined)).toBeNull();
    }
  });
});

describe('statementInvoiceItems', () => {
  it('makes one item per workspace licence charge and one per extra-credit charge, adding up to the statement', () => {
    const items = statementInvoiceItems(lines, '2026-10');
    expect(items).toEqual([
      { amountCents: 30000, description: 'Acme, 2026-10 (31/31 days)' },
      { amountCents: 6000, description: 'Beta, 2026-10 (15/31 days)' },
      { amountCents: 1200, description: 'Beta, extra credits 2026-10' },
    ]);
    expect(items.reduce((s, i) => s + i.amountCents, 0)).toBe(37200);
  });

  it('drops a line with nothing to charge', () => {
    expect(statementInvoiceItems([{ ...lines[0]!, due: '0.00' }], '2026-10')).toEqual([]);
  });
});

describe('invoiceStatement', () => {
  it('creates a send_invoice on the partner customer, attaches the items, finalizes, sends and records it', async () => {
    const { db, written } = createFakeDb({
      selects: [[statementRow()], lines],
      returns: [[], [statementRow({ status: 'invoiced' })]],
    });

    const result = await invoiceStatement(env, db, 'pst_1', 'cron:ptr_a:2026-10');

    expect(result.outcome).toBe('invoiced');
    expect(mocks.createPartnerDraftInvoice).toHaveBeenCalledWith(
      'sk_test_x',
      expect.objectContaining({
        customerId: 'cus_partner',
        currency: 'USD',
        daysUntilDue: 30,
        metadata: { kind: 'partner_statement', statementId: 'pst_1', partnerId: 'ptr_a', period: '2026-10' },
      }),
      'cron:ptr_a:2026-10:invoice',
    );
    const items = mocks.createPartnerInvoiceItem.mock.calls.map((c) => c[1]);
    expect(items.map((i) => i.amountCents)).toEqual([30000, 6000, 1200]);
    expect(items.every((i) => i.invoiceId === 'in_draft' && i.customerId === 'cus_partner')).toBe(true);
    // Order: draft, items, finalize, send.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    expect(order(mocks.createPartnerDraftInvoice)).toBeLessThan(order(mocks.createPartnerInvoiceItem));
    expect(order(mocks.createPartnerInvoiceItem)).toBeLessThan(order(mocks.finalizePartnerInvoice));
    expect(order(mocks.finalizePartnerInvoice)).toBeLessThan(order(mocks.sendPartnerInvoice));

    const updates = written('update') as Array<Record<string, unknown>>;
    // The draft id is stored first, so a failure afterwards retries against it.
    expect(updates[0]).toMatchObject({ stripeInvoiceId: 'in_draft' });
    expect(updates[1]).toMatchObject({
      status: 'invoiced',
      stripeInvoiceId: 'in_draft',
      stripeInvoiceUrl: 'https://invoice.stripe.com/i/in_draft',
      stripeInvoicePdf: 'https://invoice.stripe.com/i/in_draft/pdf',
      dueAt: new Date(1_795_000_000 * 1000),
    });
  });

  it('clamps net-0 terms to the one day Stripe requires', async () => {
    const { db } = createFakeDb({
      selects: [[statementRow({ contractSnapshot: { paymentTermsDays: 0 } })], lines],
      returns: [[], [statementRow({ status: 'invoiced' })]],
    });
    await invoiceStatement(env, db, 'pst_1', 'k');
    expect(mocks.createPartnerDraftInvoice.mock.calls[0]![1].daysUntilDue).toBe(1);
  });

  it('still records the statement as invoiced when only the email send fails', async () => {
    mocks.sendPartnerInvoice.mockRejectedValue(new Error('Cannot send: customer has no email'));
    const { db } = createFakeDb({
      selects: [[statementRow()], lines],
      returns: [[], [statementRow({ status: 'invoiced' })]],
    });
    const result = await invoiceStatement(env, db, 'pst_1', 'k');
    expect(result.outcome).toBe('invoiced');
  });

  it('leaves a zero statement final, without touching Stripe', async () => {
    const { db } = createFakeDb({ selects: [[statementRow({ totalDue: '0.00' })]] });
    const result = await invoiceStatement(env, db, 'pst_1', 'k');
    expect(result.outcome).toBe('no_charge');
    expect(mocks.createPartnerDraftInvoice).not.toHaveBeenCalled();
  });

  it('never re-invoices a statement that is already invoiced or paid', async () => {
    for (const [status, outcome] of [['invoiced', 'already_invoiced'], ['paid', 'paid']] as const) {
      const { db } = createFakeDb({ selects: [[statementRow({ status })]] });
      expect((await invoiceStatement(env, db, 'pst_1', 'k')).outcome).toBe(outcome);
    }
    expect(mocks.createPartnerDraftInvoice).not.toHaveBeenCalled();
  });

  it('refuses a voided statement', async () => {
    const { db } = createFakeDb({ selects: [[statementRow({ status: 'void' })]] });
    await expect(invoiceStatement(env, db, 'pst_1', 'k')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses to invoice a total that differs from the statement lines', async () => {
    const { db } = createFakeDb({
      selects: [[statementRow({ totalDue: '999.00' })], lines],
    });
    await expect(invoiceStatement(env, db, 'pst_1', 'k')).rejects.toBeInstanceOf(AdminBillingError);
    expect(mocks.createPartnerDraftInvoice).not.toHaveBeenCalled();
  });

  it('fails clearly when Stripe is not configured', async () => {
    const { db } = createFakeDb({ selects: [[statementRow()]] });
    await expect(invoiceStatement({ ...env, STRIPE_SECRET_KEY: '' } as Env, db, 'pst_1', 'k')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  describe('retrying a half-finished run', () => {
    it('replaces a leftover draft invoice instead of duplicating items', async () => {
      mocks.retrievePartnerInvoice.mockResolvedValue({ id: 'in_old', status: 'draft', amount_due: 0, currency: 'usd' });
      const { db } = createFakeDb({
        selects: [[statementRow({ stripeInvoiceId: 'in_old' })], lines],
        returns: [[], [statementRow({ status: 'invoiced' })]],
      });
      await invoiceStatement(env, db, 'pst_1', 'k');
      expect(mocks.deletePartnerDraftInvoice).toHaveBeenCalledWith('sk_test_x', 'in_old');
      expect(mocks.createPartnerDraftInvoice).toHaveBeenCalledTimes(1);
    });

    it('adopts an open invoice for the same amount (finalised, but the row was never updated)', async () => {
      mocks.retrievePartnerInvoice.mockResolvedValue({
        id: 'in_open',
        status: 'open',
        total: 37200,
        amount_due: 37200,
        currency: 'usd',
        due_date: 1_795_000_000,
        hosted_invoice_url: 'https://invoice.stripe.com/i/in_open',
      });
      const { db, written } = createFakeDb({
        selects: [[statementRow({ stripeInvoiceId: 'in_open' })]],
        returns: [[statementRow({ status: 'invoiced' })]],
      });
      const result = await invoiceStatement(env, db, 'pst_1', 'k');
      expect(result.outcome).toBe('invoiced');
      expect(mocks.createPartnerDraftInvoice).not.toHaveBeenCalled();
      expect(written('update')[0]).toMatchObject({ status: 'invoiced', stripeInvoiceId: 'in_open' });
    });

    it('voids an open invoice whose amount no longer matches and issues a fresh one', async () => {
      mocks.retrievePartnerInvoice.mockResolvedValue({ id: 'in_stale', status: 'open', total: 100, amount_due: 100, currency: 'usd' });
      const { db } = createFakeDb({
        selects: [[statementRow({ stripeInvoiceId: 'in_stale' })], lines],
        returns: [[], [statementRow({ status: 'invoiced' })]],
      });
      await invoiceStatement(env, db, 'pst_1', 'k');
      expect(mocks.voidPartnerInvoice).toHaveBeenCalledWith('sk_test_x', 'in_stale', 'k:void-stale');
      expect(mocks.createPartnerDraftInvoice).toHaveBeenCalledTimes(1);
    });

    it('marks the statement paid when its invoice was already paid in Stripe', async () => {
      mocks.retrievePartnerInvoice.mockResolvedValue({ id: 'in_paid', status: 'paid', amount_due: 0, currency: 'usd' });
      mocks.markStatementPaidByInvoice.mockResolvedValue({ partnerId: 'ptr_a', statementId: 'pst_1' });
      mocks.recomputePartnerStatus.mockResolvedValue({ changed: false, previousStatus: 'active', state: { status: 'active' } });
      const { db } = createFakeDb({
        selects: [[statementRow({ stripeInvoiceId: 'in_paid' })], [statementRow({ status: 'paid' })]],
      });
      const result = await invoiceStatement(env, db, 'pst_1', 'k');
      expect(result.outcome).toBe('paid');
      expect(mocks.createPartnerDraftInvoice).not.toHaveBeenCalled();
    });
  });
});

describe('runPartnerStatement', () => {
  const period = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
  const now = new Date('2026-11-01T03:17:00Z');

  it('refuses a month that has not ended', async () => {
    const { db } = createFakeDb();
    await expect(
      runPartnerStatement(env, db, { partnerId: 'ptr_a', period, keyBase: 'k', reopenVoided: true, now: new Date('2026-10-20T00:00:00Z') }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('leaves an invoiced or paid statement untouched', async () => {
    const { db } = createFakeDb({ selects: [[statementRow({ status: 'invoiced' })]] });
    const run = await runPartnerStatement(env, db, { partnerId: 'ptr_a', period, keyBase: 'k', reopenVoided: true, now });
    expect(run.action).toBe('unchanged');
    expect(mocks.buildStatement).not.toHaveBeenCalled();
  });

  it('skips a voided statement unless an admin explicitly re-runs it', async () => {
    const { db } = createFakeDb({ selects: [[statementRow({ status: 'void' })]] });
    const run = await runPartnerStatement(env, db, { partnerId: 'ptr_a', period, keyBase: 'k', reopenVoided: false, now });
    expect(run.action).toBe('skipped_void');
    expect(mocks.buildStatement).not.toHaveBeenCalled();
  });

  it('re-opens a voided statement as a draft, then rebuilds it', async () => {
    mocks.buildStatement.mockResolvedValue({ built: true });
    mocks.saveStatement.mockResolvedValue({ id: 'pst_1' });
    const { db, written } = createFakeDb({
      selects: [[statementRow({ status: 'void', stripeInvoiceId: 'in_voided' })], [statementRow({ totalDue: '0.00' })]],
    });
    const run = await runPartnerStatement(env, db, { partnerId: 'ptr_a', period, keyBase: 'k', reopenVoided: true, now });
    expect(written('update')[0]).toMatchObject({ status: 'draft', stripeInvoiceId: null, stripeInvoiceUrl: null, paidAt: null });
    expect(mocks.buildStatement).toHaveBeenCalledWith(db, 'ptr_a', period);
    expect(mocks.saveStatement).toHaveBeenCalledWith(db, { built: true }, 'final');
    expect(run.action).toBe('finalized_no_charge');
  });

  it('builds, saves as final and invoices a fresh month', async () => {
    mocks.buildStatement.mockResolvedValue({ built: true });
    mocks.saveStatement.mockResolvedValue({ id: 'pst_1' });
    const { db } = createFakeDb({
      selects: [[], [statementRow()], lines],
      returns: [[], [statementRow({ status: 'invoiced' })]],
    });
    const run = await runPartnerStatement(env, db, { partnerId: 'ptr_a', period, keyBase: 'admin:run:req', reopenVoided: true, now });
    expect(run.action).toBe('invoiced');
    expect(mocks.createPartnerDraftInvoice.mock.calls[0]![2]).toBe('admin:run:req:invoice');
  });

  it('reports an unknown partner', async () => {
    mocks.getPartner.mockResolvedValue(null);
    const { db } = createFakeDb();
    await expect(
      runPartnerStatement(env, db, { partnerId: 'ptr_x', period, keyBase: 'k', reopenVoided: true, now }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('voidPartnerStatement', () => {
  const input = { partnerId: 'ptr_a', statementId: 'pst_1', keyBase: 'admin:statement.void:req' };

  beforeEach(() => {
    mocks.recomputePartnerStatus.mockResolvedValue({ changed: true, previousStatus: 'suspended', state: { status: 'active' } });
  });

  it('voids the open Stripe invoice, marks the statement void and lifts the partner status', async () => {
    mocks.retrievePartnerInvoice.mockResolvedValue({ id: 'in_1', status: 'open', amount_due: 100, currency: 'usd' });
    const { db, written } = createFakeDb({
      selects: [[statementRow({ status: 'invoiced', stripeInvoiceId: 'in_1' })]],
      returns: [[statementRow({ status: 'void' })], []],
    });
    const row = await voidPartnerStatement(env, db, input);
    expect(mocks.voidPartnerInvoice).toHaveBeenCalledWith('sk_test_x', 'in_1', 'admin:statement.void:req:void');
    expect(row.status).toBe('void');
    expect(written('update')[0]).toMatchObject({ status: 'void' });
    // Read-only lifts at once: both workspace caches are dropped.
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
    expect(kvDelete).toHaveBeenCalledWith('ws:org_2');
  });

  it('deletes a draft invoice instead of voiding it', async () => {
    mocks.retrievePartnerInvoice.mockResolvedValue({ id: 'in_1', status: 'draft', amount_due: 0, currency: 'usd' });
    const { db } = createFakeDb({
      selects: [[statementRow({ status: 'final', stripeInvoiceId: 'in_1' })]],
      returns: [[statementRow({ status: 'void' })], []],
    });
    await voidPartnerStatement(env, db, input);
    expect(mocks.deletePartnerDraftInvoice).toHaveBeenCalledWith('sk_test_x', 'in_1');
    expect(mocks.voidPartnerInvoice).not.toHaveBeenCalled();
  });

  it('voids a statement that never got an invoice without calling Stripe', async () => {
    const { db } = createFakeDb({ selects: [[statementRow()]], returns: [[statementRow({ status: 'void' })], []] });
    await voidPartnerStatement(env, db, input);
    expect(mocks.retrievePartnerInvoice).not.toHaveBeenCalled();
  });

  it('refuses a paid or already void statement, and one that does not belong to the partner', async () => {
    await expect(
      voidPartnerStatement(env, createFakeDb({ selects: [[statementRow({ status: 'paid' })]] }).db, input),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      voidPartnerStatement(env, createFakeDb({ selects: [[statementRow({ status: 'void' })]] }).db, input),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(voidPartnerStatement(env, createFakeDb({ selects: [[]] }).db, input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('records a statement that turns out to be paid in Stripe as paid, and refuses the void', async () => {
    mocks.retrievePartnerInvoice.mockResolvedValue({ id: 'in_1', status: 'paid', amount_due: 0, currency: 'usd' });
    mocks.markStatementPaidByInvoice.mockResolvedValue({ partnerId: 'ptr_a', statementId: 'pst_1' });
    const { db } = createFakeDb({ selects: [[statementRow({ status: 'invoiced', stripeInvoiceId: 'in_1' })]] });
    await expect(voidPartnerStatement(env, db, input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.markStatementPaidByInvoice).toHaveBeenCalled();
    expect(mocks.voidPartnerInvoice).not.toHaveBeenCalled();
  });
});

describe('handlePartnerInvoicePaid', () => {
  it('marks the statement paid, recomputes the partner and drops the workspace caches when the status lifts', async () => {
    mocks.markStatementPaidByInvoice.mockResolvedValue({ partnerId: 'ptr_a', statementId: 'pst_1' });
    mocks.recomputePartnerStatus.mockResolvedValue({
      changed: true,
      previousStatus: 'suspended',
      state: { status: 'active' },
    });
    const { db, written } = createFakeDb();

    await handlePartnerInvoicePaid(env, db, 'in_1');

    expect(mocks.markStatementPaidByInvoice).toHaveBeenCalledWith(db, 'in_1', expect.any(Date));
    expect(mocks.recomputePartnerStatus).toHaveBeenCalledWith(db, 'ptr_a');
    expect(kvDelete).toHaveBeenCalledWith('ws:org_1');
    expect(kvDelete).toHaveBeenCalledWith('ws:org_2');
    const audit = written('insert') as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(['statement.paid', 'partner.status.auto']);
  });

  it('leaves caches alone when the status did not change', async () => {
    mocks.markStatementPaidByInvoice.mockResolvedValue({ partnerId: 'ptr_a', statementId: 'pst_1' });
    mocks.recomputePartnerStatus.mockResolvedValue({ changed: false, previousStatus: 'active', state: { status: 'active' } });
    await handlePartnerInvoicePaid(env, createFakeDb().db, 'in_1');
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it('is safe to replay: a statement that is already paid still gets its partner recomputed', async () => {
    mocks.markStatementPaidByInvoice.mockResolvedValue(null);
    mocks.recomputePartnerStatus.mockResolvedValue({ changed: true, previousStatus: 'past_due', state: { status: 'active' } });
    const { db, written } = createFakeDb({ selects: [[{ partnerId: 'ptr_a' }]] });

    await handlePartnerInvoicePaid(env, db, 'in_1');

    expect(mocks.recomputePartnerStatus).toHaveBeenCalledWith(db, 'ptr_a');
    // No second "statement.paid" audit row on a replay.
    expect((written('insert') as Array<{ action: string }>).map((a) => a.action)).toEqual(['partner.status.auto']);
  });

  it('ignores an invoice no statement owns', async () => {
    mocks.markStatementPaidByInvoice.mockResolvedValue(null);
    await handlePartnerInvoicePaid(env, createFakeDb({ selects: [[]] }).db, 'in_unknown');
    expect(mocks.recomputePartnerStatus).not.toHaveBeenCalled();
  });
});

describe('handlePartnerInvoiceVoided', () => {
  it('voids the statement and recomputes the partner when its invoice is voided in Stripe', async () => {
    mocks.recomputePartnerStatus.mockResolvedValue({ changed: false, previousStatus: 'active', state: { status: 'active' } });
    const { db, written } = createFakeDb({ returns: [[{ id: 'pst_1', partnerId: 'ptr_a' }]] });
    await handlePartnerInvoiceVoided(env, db, 'in_1');
    expect(written('update')[0]).toMatchObject({ status: 'void' });
    expect(mocks.recomputePartnerStatus).toHaveBeenCalledWith(db, 'ptr_a');
  });

  it('does nothing for an invoice that is not an open partner statement', async () => {
    await handlePartnerInvoiceVoided(env, createFakeDb({ returns: [[]] }).db, 'in_x');
    expect(mocks.recomputePartnerStatus).not.toHaveBeenCalled();
  });
});
