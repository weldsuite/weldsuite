/**
 * 1099 filings end to end (pglite): create, adjust, review, generate, the IRIS
 * file (the only place full TINs leave, with a reveal row per recipient), copies,
 * marking filed, a correction, and the IRS TIN matching round trip.
 * docs/plans/weldbooks-us.md section 8.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingContactsRoutes } from '../accounting-contacts';
import { form1099Routes } from './index';
import {
  events,
  seedBill,
  seedEntityAndVendors,
  seedPayment,
  seedPaymentHistory,
  type ApiResult,
  type Fixture,
} from '../../services/form-1099/test-fixtures';
import { tinMatchAccountNumber } from '@weldsuite/books-domain/us-compliance/tin-matching';

let db: Database;
let fx: Fixture;

const api = (path: string, opts: Parameters<Fixture['call']>[3] = {}): Promise<ApiResult> =>
  fx.call('/api/form-1099', form1099Routes, path, opts);

const TAX_FILE = ['taxes:read', 'taxes:file'];
const TAX_FILE_REVEAL = ['taxes:read', 'taxes:file', 'tax_ids:reveal'];

// Recipients' full TINs, digits only.
const TIN = {
  alpha: '234567891',
  bravo: '456789012',
  delta: '567890123',
  hotel: '345678901',
  foxtrot: '234567890',
  golf: null,
  payer: '123456789',
} as const;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  fx = await seedEntityAndVendors(db);
  await seedPaymentHistory(fx);
}, 180_000);

function lineOf(detail: { lines: Array<{ partyId: string; id: string; [k: string]: unknown }> }, key: string) {
  return detail.lines.find((l) => l.partyId === fx.parties[key])!;
}

describe('summary, deadlines and Form 945 endpoints', () => {
  it('returns the summary, validated year and permissions', async () => {
    const res = await api('/summary?year=2025', { perms: ['taxes:read'] });
    expect(res.status).toBe(200);
    expect(res.data.taxYear).toBe(2025);
    expect(res.data.vendors.length).toBeGreaterThan(5);
    expect(res.text).not.toContain(TIN.alpha);

    expect((await api('/summary?year=2025', { perms: ['invoices:read'] })).status).toBe(403);
    expect((await api('/summary?year=1999', { perms: ['taxes:read'] })).status).toBe(400);
    expect((await api('/summary?year=abc', { perms: ['taxes:read'] })).status).toBe(400);
  });

  it('answers the drill-down, deadlines and Form 945', async () => {
    const detail = await api(`/vendors/${fx.parties.alpha}?year=2025`, { perms: ['taxes:read'] });
    expect(detail.status).toBe(200);
    expect(detail.data.contributions[0].payment.checkNumber).toBe('1001');
    expect((await api('/vendors/pty_missing?year=2025', { perms: ['taxes:read'] })).status).toBe(404);

    const deadlines = await api('/deadlines?year=2026', { perms: ['taxes:read'] });
    expect(deadlines.data.nec.recipient).toBe('2027-02-01');
    expect(deadlines.data.eFile).toMatchObject({ requiredFrom: 10, waiverRequestDays: 45 });

    const form945 = await api('/945?year=2025', { perms: ['taxes:read'] });
    expect(form945.data.backupWithholding).toBe(720);
  });
});

describe('NEC filing for 2025', () => {
  let filingId: string;
  let detail: ApiResult;

  it('creates a draft with one line per recipient, and only one per form and year', async () => {
    const res = await api('/filings', { method: 'POST', body: { taxYear: 2025, formType: 'nec' }, perms: ['taxes:create', 'taxes:read'] });
    expect(res.status).toBe(201);
    filingId = res.data.filing.id;
    expect(res.data.filing).toMatchObject({ status: 'draft', taxYear: 2025, formType: 'nec', lineCount: 5 });

    const byKey = (key: string) => lineOf(res.data, key);
    expect(byKey('alpha')).toMatchObject({ status: 'included', boxes: { nec_1: 4000 }, partyName: 'Alpha Contractor' });
    expect(byKey('alpha').recipient).toMatchObject({ name: 'Alice Alpha', businessName: 'Alpha Contractor', tinType: 'ssn', tinLast4: '7891' });
    expect(byKey('bravo')).toMatchObject({ status: 'included', boxes: { nec_1: 1500 } });
    expect(byKey('delta')).toMatchObject({ status: 'included', boxes: { nec_1: 8000 } });
    expect(byKey('hotel')).toMatchObject({ status: 'included', boxes: { nec_1: 700 } });
    expect(byKey('golf')).toMatchObject({ status: 'needs_tin', boxes: { nec_1: 3000, nec_4: 720 }, federalWithheld: '720.00' });
    // Corporations, MISC-only vendors and unflagged vendors are not on the NEC filing.
    expect(res.data.lines.map((l: { partyId: string }) => l.partyId)).not.toContain(fx.parties.charlie);
    expect(res.data.lines.map((l: { partyId: string }) => l.partyId)).not.toContain(fx.parties.echo);
    expect(res.data.lines.map((l: { partyId: string }) => l.partyId)).not.toContain(fx.parties.foxtrot);
    expect(res.data.filing.totals).toEqual({ amount: 4000 + 1500 + 8000 + 700 + 3000, withheld: 720 });
    expect(res.text).not.toContain('recipientTinEncrypted');
    expect(res.text).not.toContain(TIN.alpha);

    const again = await api('/filings', { method: 'POST', body: { taxYear: 2025, formType: 'nec' }, perms: ['taxes:create'] });
    expect(again.status).toBe(409);
    expect((again.error?.details as { filingId: string }).filingId).toBe(filingId);
  });

  it('lists and fetches filings', async () => {
    const list = await api('/filings?year=2025&formType=nec', { perms: ['taxes:read'] });
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ id: filingId, lineCount: 5, statusCounts: { included: 4, needs_tin: 1 } });
    detail = await api(`/filings/${filingId}`, { perms: ['taxes:read'] });
    expect(detail.data.lines).toHaveLength(5);
    expect((await api('/filings/f99_missing', { perms: ['taxes:read'] })).status).toBe(404);
  });

  it('adjusts a line with a reason, and takes a recipient out when the amount drops below the threshold', async () => {
    const bravo = lineOf(detail.data, 'bravo').id as string;
    const withoutReason = await api(`/filings/${filingId}/lines/${bravo}`, {
      method: 'PATCH',
      body: { adjustments: [{ box: 'nec_1', amount: 500, reason: '' }] },
      perms: ['taxes:update'],
    });
    expect(withoutReason.status).toBe(400);

    const up = await api(`/filings/${filingId}/lines/${bravo}`, {
      method: 'PATCH',
      body: { adjustments: [{ box: 'nec_1', amount: 500, reason: 'Check 998 was not in the books' }] },
      perms: ['taxes:update'],
    });
    expect(up.status).toBe(200);
    expect(lineOf(up.data, 'bravo')).toMatchObject({
      status: 'included',
      boxes: { nec_1: 2000 },
      adjustments: [{ box: 'nec_1', amount: 500, reason: 'Check 998 was not in the books', by: 'user_test_default' }],
    });

    const down = await api(`/filings/${filingId}/lines/${bravo}`, {
      method: 'PATCH',
      body: { adjustments: [{ box: 'nec_1', amount: -1000, reason: 'Refunded in March' }] },
      perms: ['taxes:update'],
    });
    expect(lineOf(down.data, 'bravo')).toMatchObject({ status: 'excluded', boxes: {} });
    expect(lineOf(down.data, 'bravo').excludedReason).toContain('Not reportable:');

    const restore = await api(`/filings/${filingId}/lines/${bravo}`, {
      method: 'PATCH',
      body: { adjustments: [] },
      perms: ['taxes:update'],
    });
    expect(lineOf(restore.data, 'bravo')).toMatchObject({ status: 'included', boxes: { nec_1: 1500 }, excludedReason: null });
  });

  it('rejects an adjustment on a box of the other form', async () => {
    const alpha = lineOf(detail.data, 'alpha').id as string;
    const res = await api(`/filings/${filingId}/lines/${alpha}`, {
      method: 'PATCH',
      body: { adjustments: [{ box: 'misc_1', amount: 100, reason: 'wrong form' }] },
      perms: ['taxes:update'],
    });
    expect(res.status).toBe(400);
    expect(res.error?.message).toContain('not an amount box of form 1099-NEC');
  });

  it('keeps manual adjustments and exclusions on refresh and picks up new payments and vendors', async () => {
    const hotel = lineOf(detail.data, 'hotel').id as string;
    const excluded = await api(`/filings/${filingId}/lines/${hotel}`, {
      method: 'PATCH',
      body: { status: 'excluded', excludedReason: 'Paid in cash, W-9 pending' },
      perms: ['taxes:update'],
    });
    expect(lineOf(excluded.data, 'hotel')).toMatchObject({ status: 'excluded', excludedReason: 'Paid in cash, W-9 pending' });
    const noReason = await api(`/filings/${filingId}/lines/${hotel}`, { method: 'PATCH', body: { status: 'excluded' }, perms: ['taxes:update'] });
    expect(noReason.status).toBe(400);

    const bravo = lineOf(detail.data, 'bravo').id as string;
    await api(`/filings/${filingId}/lines/${bravo}`, {
      method: 'PATCH',
      body: { adjustments: [{ box: 'nec_1', amount: 100, reason: 'Late invoice' }] },
      perms: ['taxes:update'],
    });

    // A new payment to Alpha and a newly flagged vendor arrive after the draft was made.
    const extra = await seedBill(fx, { vendor: 'alpha', date: '2025-12-10', number: 'ALPHA-5', lines: [{ description: 'Extra work', amount: 1000, accountCode: '6030' }] });
    await seedPayment(fx, { vendor: 'alpha', date: '2025-12-20', amount: 1000, checkNumber: '1010', bills: [{ id: extra.id, total: extra.total }] });
    const flagged = await fx.call('/api/accounting-contacts', accountingContactsRoutes, `/${fx.parties.foxtrot}`, {
      method: 'PATCH',
      body: { is1099Vendor: true, default1099Form: 'nec', default1099Box: 'nec_1', tinType: 'ein', tin: '23-4567890' },
    });
    expect(flagged.status).toBe(200);

    const refresh = await api(`/filings/${filingId}/refresh`, { method: 'POST', perms: ['taxes:update'] });
    expect(refresh.status).toBe(200);
    expect(refresh.data.refresh.added).toBe(1);
    expect(lineOf(refresh.data, 'alpha')).toMatchObject({ boxes: { nec_1: 5000 } });
    expect(lineOf(refresh.data, 'bravo')).toMatchObject({ boxes: { nec_1: 1600 }, adjustments: [{ amount: 100, reason: 'Late invoice' }] });
    expect(lineOf(refresh.data, 'hotel')).toMatchObject({ status: 'excluded', excludedReason: 'Paid in cash, W-9 pending' });
    expect(lineOf(refresh.data, 'foxtrot')).toMatchObject({ status: 'included', boxes: { nec_1: 4000 } });
  });

  it('writes a state hint and takes state fields', async () => {
    const alpha = lineOf((await api(`/filings/${filingId}`, { perms: ['taxes:read'] })).data, 'alpha').id as string;
    const res = await api(`/filings/${filingId}/lines/${alpha}`, {
      method: 'PATCH',
      body: { stateCode: 'tx', stateIdNumber: 'TX-123', stateIncome: 5000, stateWithheld: 0 },
      perms: ['taxes:update'],
    });
    expect(lineOf(res.data, 'alpha')).toMatchObject({ stateCode: 'TX', stateIdNumber: 'TX-123', stateIncome: '5000.00' });
    expect(lineOf(res.data, 'alpha').stateHint).toMatchObject({ state: 'TX', direct: 'none', needsDirectFiling: false });
  });

  it('refuses to generate before review, and while recipients still need a TIN', async () => {
    const early = await api(`/filings/${filingId}/generate`, { method: 'POST', perms: ['taxes:file'] });
    expect(early.status).toBe(409);
    expect(early.error?.message).toContain('Review');

    const noPermission = await api(`/filings/${filingId}/review`, { method: 'POST', perms: ['taxes:read'] });
    expect(noPermission.status).toBe(403);
    const reviewed = await api(`/filings/${filingId}/review`, { method: 'POST', perms: ['taxes:update'] });
    expect(reviewed.status).toBe(200);
    expect(reviewed.data.filing.status).toBe('reviewed');
    expect(reviewed.data.unresolved).toEqual([expect.objectContaining({ status: 'needs_tin' })]);

    const blocked = await api(`/filings/${filingId}/generate`, { method: 'POST', perms: ['taxes:file'] });
    expect(blocked.status).toBe(409);
    expect(blocked.error?.message).toContain('need a TIN');
    expect((blocked.error?.details as { lines: unknown[] }).lines).toHaveLength(1);

    // Nothing is IRIS-ready before generation.
    const early2 = await api(`/filings/${filingId}/iris-csv`, { perms: TAX_FILE_REVEAL });
    expect(early2.status).toBe(409);
  });

  it('generates once the open recipient is excluded, snapshotting recipients and sealing TINs', async () => {
    const golf = lineOf((await api(`/filings/${filingId}`, { perms: ['taxes:read'] })).data, 'golf').id as string;
    await api(`/filings/${filingId}/lines/${golf}`, {
      method: 'PATCH',
      body: { status: 'excluded', excludedReason: 'Chasing a W-9' },
      perms: ['taxes:update'],
    });
    const res = await api(`/filings/${filingId}/generate`, { method: 'POST', perms: ['taxes:file'] });
    expect(res.status).toBe(200);
    expect(res.data.filing.status).toBe('generated');
    expect(res.data.filing.generatedAt).toBeTruthy();
    const included = res.data.lines.filter((l: { status: string }) => l.status === 'included');
    expect(included).toHaveLength(4);
    for (const line of included) expect(line.hasTin).toBe(true);
    expect(res.text).not.toContain('recipientTinEncrypted');
    for (const digits of [TIN.alpha, TIN.bravo, TIN.delta]) expect(res.text).not.toContain(digits);

    const rows = await db.select().from(schema.form1099FilingLines).where(eq(schema.form1099FilingLines.filingId, filingId));
    const sealed = rows.filter((r) => r.recipientTinEncrypted);
    expect(sealed).toHaveLength(4);
    for (const row of sealed) {
      for (const digits of [TIN.alpha, TIN.bravo, TIN.delta, TIN.foxtrot]) expect(row.recipientTinEncrypted).not.toContain(digits);
    }
    expect(JSON.stringify(rows.map((r) => r.recipient))).not.toContain(TIN.alpha);

    // No edits after generation.
    const edit = await api(`/filings/${filingId}/lines/${golf}`, { method: 'PATCH', body: { status: 'included' }, perms: ['taxes:update'] });
    expect(edit.status).toBe(409);
    expect((await api(`/filings/${filingId}/refresh`, { method: 'POST', perms: ['taxes:update'] })).status).toBe(409);
    expect((await api(`/filings/${filingId}`, { method: 'DELETE', perms: ['taxes:delete'] })).status).toBe(409);
  });

  it('builds the IRIS file with full TINs only for tax_ids:reveal, one reveal row per recipient', async () => {
    const noReveal = await api(`/filings/${filingId}/iris-csv`, { perms: TAX_FILE });
    expect(noReveal.status).toBe(403);
    const noFile = await api(`/filings/${filingId}/iris-csv`, { perms: ['taxes:read', 'tax_ids:reveal'] });
    expect(noFile.status).toBe(403);
    expect(await db.select().from(schema.taxIdReveals)).toHaveLength(0);

    const res = await api(`/filings/${filingId}/iris-csv`, { perms: TAX_FILE_REVEAL });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.data).toMatchObject({ taxYear: 2025, formType: 'nec', correctionsOnly: false });
    expect(res.data.files).toHaveLength(1);
    const file = res.data.files[0];
    expect(file.filename).toBe('iris-1099-nec-2025.csv');
    expect(file.recordCount).toBe(4);
    const [header, ...records] = (file.content as string).trim().split('\r\n');
    expect(header).toContain('Recipient Taxpayer ID Number');
    expect(records).toHaveLength(4);
    const text = file.content as string;
    for (const digits of [TIN.alpha, TIN.bravo, TIN.delta, TIN.foxtrot, TIN.payer]) expect(text).toContain(digits);
    expect(text).not.toContain(TIN.hotel); // excluded recipient
    expect(text).toContain('1099-NEC');
    expect(text).toContain('5000.00');
    expect(text).toContain('Acme Studio LLC');
    expect(file.warnings.join(' ')).not.toContain('Payer');

    const reveals = await db.select().from(schema.taxIdReveals);
    expect(reveals).toHaveLength(4);
    for (const row of reveals) {
      expect(row).toMatchObject({ subjectType: 'form_1099_line', field: 'tin', reason: 'iris_file', revealedBy: 'user_test_default', entityId: fx.entityId });
    }
    const lineIds = new Set((await api(`/filings/${filingId}`, { perms: ['taxes:read'] })).data.lines.map((l: { id: string }) => l.id));
    for (const row of reveals) expect(lineIds.has(row.subjectId)).toBe(true);
  });

  it('passes a downloaded template header row through', async () => {
    const res = await api(`/filings/${filingId}/iris-csv`, {
      method: 'POST',
      body: { templateHeaders: ['Recipient Taxpayer ID Number', 'Box 1 - Nonemployee Compensation', 'Mystery Column'] },
      perms: TAX_FILE_REVEAL,
    });
    expect(res.status).toBe(200);
    const file = res.data.files[0];
    expect((file.content as string).split('\r\n')[0]).toBe('Recipient Taxpayer ID Number,Box 1 - Nonemployee Compensation,Mystery Column');
    expect(file.warnings.join(' ')).toContain('Mystery Column');

    const viaQuery = await api(`/filings/${filingId}/iris-csv?templateHeaders=${encodeURIComponent('"Recipient Taxpayer ID Number","Box 1 - Nonemployee Compensation"')}`, { perms: TAX_FILE_REVEAL });
    expect((viaQuery.data.files[0].content as string).split('\r\n')[0]).toBe('Recipient Taxpayer ID Number,Box 1 - Nonemployee Compensation');
  });

  it('builds copy data with the recipient TIN truncated to the last four digits', async () => {
    const alpha = lineOf((await api(`/filings/${filingId}`, { perms: ['taxes:read'] })).data, 'alpha').id as string;
    const res = await api(`/filings/${filingId}/lines/${alpha}/copies?copies=B,C`, { perms: ['taxes:read'] });
    expect(res.status).toBe(200);
    expect(res.data.copies).toHaveLength(2);
    expect(res.data.copies.map((c: { copy: string }) => c.copy)).toEqual(['B', 'C']);
    expect(res.data.recipientTin).toBe('***-**-7891');
    expect(res.text).toContain('***-**-7891');
    expect(res.text).not.toContain(TIN.alpha);
    expect(res.text).not.toContain('234-56-7891');
    expect((await api(`/filings/${filingId}/lines/${alpha}/copies?copies=Z`, { perms: ['taxes:read'] })).status).toBe(400);
  });

  it('records delivery, printed or by email only after the recipient consented', async () => {
    const alpha = lineOf((await api(`/filings/${filingId}`, { perms: ['taxes:read'] })).data, 'alpha').id as string;
    const email = await api(`/filings/${filingId}/lines/${alpha}/delivered`, { method: 'POST', body: { method: 'email' }, perms: ['taxes:update'] });
    expect(email.status).toBe(409);
    expect(email.error?.message).toContain('electronic delivery');

    const print = await api(`/filings/${filingId}/lines/${alpha}/delivered`, { method: 'POST', body: { method: 'print' }, perms: ['taxes:update'] });
    expect(print.status).toBe(200);
    expect(print.data.deliveryMethod).toBe('print');

    await fx.call('/api/accounting-contacts', accountingContactsRoutes, `/${fx.parties.alpha}`, {
      method: 'PATCH',
      body: { form1099EDeliveryConsentAt: new Date().toISOString() },
    });
    const ok = await api(`/filings/${filingId}/lines/${alpha}/delivered`, { method: 'POST', body: { method: 'email' }, perms: ['taxes:update'] });
    expect(ok.status).toBe(200);
    expect(lineOf(ok.data, 'alpha')).toMatchObject({ deliveryMethod: 'email' });
    expect(lineOf(ok.data, 'alpha').deliveredAt).toBeTruthy();
  });

  it('marks the filing filed, once', async () => {
    const noConfirmation = await api(`/filings/${filingId}/mark-filed`, { method: 'POST', body: {}, perms: ['taxes:file'] });
    expect(noConfirmation.status).toBe(400);
    const res = await api(`/filings/${filingId}/mark-filed`, {
      method: 'POST',
      body: { confirmationNumber: 'IRIS-TY25-0001', filedAt: '2026-01-28' },
      perms: ['taxes:file'],
    });
    expect(res.status).toBe(200);
    expect(res.data.filing).toMatchObject({ status: 'filed', confirmationNumber: 'IRIS-TY25-0001' });
    expect(res.data.filing.filedAt).toContain('2026-01-28');
    expect(res.data.lines.filter((l: { status: string }) => l.status === 'filed')).toHaveLength(4);
    expect((await api(`/filings/${filingId}/mark-filed`, { method: 'POST', body: { confirmationNumber: 'again' }, perms: ['taxes:file'] })).status).toBe(409);
  });

  it('corrects a filed recipient with a new line, and files the correction', async () => {
    const alpha = lineOf((await api(`/filings/${filingId}`, { perms: ['taxes:read'] })).data, 'alpha').id as string;
    const bad = await api(`/filings/${filingId}/lines/${alpha}/correct`, { method: 'POST', body: { boxes: { nec_1: 3500 }, reason: '' }, perms: ['taxes:file'] });
    expect(bad.status).toBe(400);

    const res = await api(`/filings/${filingId}/lines/${alpha}/correct`, {
      method: 'POST',
      body: { boxes: { nec_1: 3500 }, reason: 'Overstated: one invoice was paid twice' },
      perms: ['taxes:file'],
    });
    expect(res.status).toBe(201);
    expect(res.data.filing.status).toBe('corrected');
    const original = res.data.lines.find((l: { id: string }) => l.id === alpha);
    const correction = res.data.lines.find((l: { id: string }) => l.id === res.data.correctionLineId);
    expect(original).toMatchObject({ status: 'filed', superseded: true });
    expect(correction).toMatchObject({
      isCorrected: true,
      correctionOfLineId: alpha,
      status: 'included',
      pendingCorrection: true,
      boxes: { nec_1: 3500 },
      adjustments: [{ box: 'nec_1', amount: -1500, reason: 'Overstated: one invoice was paid twice' }],
    });

    // The correction run holds only the correction, flagged as corrected.
    const iris = await api(`/filings/${filingId}/iris-csv`, { perms: TAX_FILE_REVEAL });
    expect(iris.data.correctionsOnly).toBe(true);
    expect(iris.data.files[0].recordCount).toBe(1);
    const rows = (iris.data.files[0].content as string).trim().split('\r\n');
    const headers = rows[0]!.split(',');
    const record = rows[1]!.split(',');
    expect(record[headers.indexOf('Corrected')]).toBe('Y');
    expect(record[headers.indexOf('Box 1 - Nonemployee Compensation')]).toBe('3500.00');

    const again = await api(`/filings/${filingId}/lines/${alpha}/correct`, { method: 'POST', body: { boxes: { nec_1: 3000 }, reason: 'again' }, perms: ['taxes:file'] });
    expect(again.status).toBe(409);

    // A pending correction can still be edited; the totals follow the effective lines.
    const edited = await api(`/filings/${filingId}/lines/${res.data.correctionLineId}`, { method: 'PATCH', body: { boxes: { nec_1: 3400 } }, perms: ['taxes:update'] });
    expect(edited.status).toBe(200);
    expect(edited.data.filing.totals.amount).toBe(3400 + 1600 + 8000 + 4000);

    const filed = await api(`/filings/${filingId}/mark-filed`, { method: 'POST', body: { confirmationNumber: 'IRIS-TY25-0002' }, perms: ['taxes:file'] });
    expect(filed.data.filing.status).toBe('filed');
    expect(filed.data.lines.find((l: { id: string }) => l.id === res.data.correctionLineId).status).toBe('filed');
  });

  it('keeps recipients, TINs and names out of every entity event', async () => {
    const filingEvents = events.filter((e) => e.eventType.startsWith('form_1099_filing:'));
    const kinds = new Set(filingEvents.map((e) => e.eventType));
    for (const kind of ['form_1099_filing:created', 'form_1099_filing:updated', 'form_1099_filing:generated', 'form_1099_filing:filed']) {
      expect(kinds, kind).toContain(kind);
    }
    for (const event of events) {
      const text = JSON.stringify(event);
      for (const digits of [TIN.alpha, TIN.bravo, TIN.delta, TIN.hotel, TIN.payer]) expect(text).not.toContain(digits);
    }
    for (const event of filingEvents) {
      const text = JSON.stringify(event);
      expect(text).not.toContain('Alice');
      expect(text).not.toContain('recipient');
    }
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'form_1099_filing'), eq(schema.auditLog.entityId, filingId)));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['created', 'refreshed', 'reviewed', 'generated', 'iris_file_created', 'filed', 'line_corrected']));
  });
});

describe('MISC filing and deleting a draft', () => {
  it('creates a MISC filing for the landlord, and deletes a draft only', async () => {
    const res = await api('/filings', { method: 'POST', body: { taxYear: 2025, formType: 'misc' }, perms: ['taxes:create'] });
    expect(res.status).toBe(201);
    expect(res.data.filing.lineCount).toBe(1);
    expect(lineOf(res.data, 'echo')).toMatchObject({ status: 'included', boxes: { misc_1: 24000 } });
    const id = res.data.filing.id;

    const draftCsv = await api(`/filings/${id}/iris-csv`, { perms: TAX_FILE_REVEAL });
    expect(draftCsv.status).toBe(409);

    const del = await api(`/filings/${id}`, { method: 'DELETE', perms: ['taxes:delete'] });
    expect(del.status).toBe(204);
    expect((await api(`/filings/${id}`, { perms: ['taxes:read'] })).status).toBe(404);
    expect(await db.select().from(schema.form1099FilingLines).where(eq(schema.form1099FilingLines.filingId, id))).toHaveLength(0);
    expect(events.some((e) => e.eventType === 'form_1099_filing:deleted' && e.entityId === id)).toBe(true);
  });
});

describe('IRS TIN matching', () => {
  it('builds the upload file from decrypted TINs, logging a reveal per vendor', async () => {
    const before = (await db.select().from(schema.taxIdReveals)).length;
    expect((await api('/tin-matching/file', { perms: TAX_FILE })).status).toBe(403);

    const res = await api('/tin-matching/file?all=true', { perms: TAX_FILE_REVEAL });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Vendors with a TIN: alpha, bravo, charlie, delta, echo, foxtrot, hotel, india (golf has none).
    expect(res.data.recordCount).toBe(8);
    const content = res.data.files[0].content as string;
    const lines = content.trim().split('\r\n');
    expect(lines).toHaveLength(8);
    expect(lines).toContain(`2;${TIN.alpha};Alice Alpha;${tinMatchAccountNumber(fx.parties.alpha!)}`);
    expect(lines).toContain(`1;${TIN.bravo};Bravo Cleaning LLC;${tinMatchAccountNumber(fx.parties.bravo!)}`);

    const after = await db.select().from(schema.taxIdReveals);
    expect(after.length - before).toBe(8);
    expect(after.filter((r) => r.reason === 'tin_matching' && r.subjectType === 'party' && r.field === 'tin')).toHaveLength(8);
  });

  it('records the IRS answer, flags mismatches and suggests backup withholding', async () => {
    const account = (key: string) => tinMatchAccountNumber(fx.parties[key]!);
    const results = [
      `2;${TIN.alpha};Alice Alpha;${account('alpha')};0`,
      `1;${TIN.bravo};Bravo Cleaning LLC;${account('bravo')};3`,
      `2;${TIN.hotel};Henry Hotel;${account('hotel')};2`,
      `1;999999999;Somebody Else;ZZZUNKNOWN;0`,
      // Charlie's TIN changed after the file went out: this answer is about the old one.
      `1;911111111;Charlie Corp;${account('charlie')};0`,
      'garbage line',
    ].join('\r\n');

    const res = await api('/tin-matching/results', { method: 'POST', body: { text: results }, perms: ['taxes:file'] });
    expect(res.status).toBe(200);
    expect(res.data.updated.sort()).toEqual([fx.parties.alpha, fx.parties.bravo, fx.parties.hotel].sort());
    expect(res.data.byStatus).toEqual({ match: 1, mismatch: 1, not_issued: 1 });
    expect(res.data.problems.map((p: { name: string; status: string }) => `${p.name}:${p.status}`).sort()).toEqual([
      'Bravo Cleaning LLC:mismatch',
      'Hotel Cash Contractor:not_issued',
    ]);
    expect(res.data.problems[0].suggestion).toContain('B notice');
    expect(res.data.stale).toEqual([expect.objectContaining({ partyId: fx.parties.charlie })]);
    expect(res.data.unknownAccounts).toEqual([expect.objectContaining({ accountNumber: 'ZZZUNKNOWN' })]);
    expect(res.data.unreadable).toHaveLength(1);

    const [alpha] = await db.select().from(schema.parties).where(eq(schema.parties.id, fx.parties.alpha!));
    expect(alpha).toMatchObject({ tinMatchStatus: 'match' });
    expect(alpha!.tinMatchedAt).toBeTruthy();
    const [charlie] = await db.select().from(schema.parties).where(eq(schema.parties.id, fx.parties.charlie!));
    expect(charlie!.tinMatchStatus).toBeNull();

    // The review screen now warns about the mismatches.
    const summary = await api('/summary?year=2025', { perms: ['taxes:read'] });
    const bravo = summary.data.vendors.find((v: { partyId: string }) => v.partyId === fx.parties.bravo);
    expect(bravo).toMatchObject({ tinMatchStatus: 'mismatch', suggestBackupWithholding: true });
    expect(bravo.reasons.join(' ')).toContain('B notice');
    expect(summary.data.warnings.join('\n')).toContain('Bravo Cleaning LLC: the IRS TIN match failed');

    // Already-matched vendors are skipped next time, unless all=true.
    const again = await api('/tin-matching/file', { perms: TAX_FILE_REVEAL });
    expect(again.data.recordCount).toBe(7);
  });

  it('turning backup withholding on stops the suggestion', async () => {
    await fx.call('/api/accounting-contacts', accountingContactsRoutes, `/${fx.parties.bravo}`, { method: 'PATCH', body: { backupWithholding: true } });
    const summary = await api('/summary?year=2025', { perms: ['taxes:read'] });
    const bravo = summary.data.vendors.find((v: { partyId: string }) => v.partyId === fx.parties.bravo);
    expect(bravo).toMatchObject({ backupWithholding: true, suggestBackupWithholding: false });
  });
});
