/**
 * Vendor tax data on /api/accounting-contacts (pglite): the TIN and the ACH
 * account number are write-only, encrypted, revealed only with tax_ids:reveal
 * (and logged), and a change to the bank details puts a verification hold on
 * the vendor. docs/plans/weldbooks-us.md section 8.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingContactsRoutes } from './index';

let db: Database;
const events: Array<{ eventType: string; entityId: string; data: Record<string, unknown> }> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: 'ab'.repeat(32),
  ENTITY_EVENTS: {
    send: async (message: { eventType: string; entityId: string; data: Record<string, unknown> }) => {
      events.push(message);
    },
  },
};

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string };
  text: string;
}

async function call(path: string, opts: { method?: string; body?: unknown; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp('/api/accounting-contacts', accountingContactsRoutes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: env as any,
    context: { permissions: permissions(...(opts.perms ?? ['invoices:read', 'invoices:create', 'invoices:update'])), tenantDb: db },
  });
  const res = await request(`/api/accounting-contacts${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: { code: string; message: string } }) : {};
  return { status: res.status, data: json.data, error: json.error, text };
}

async function createVendor(extra: Record<string, unknown> = {}, name = 'Beta Roofing LLC'): Promise<Result> {
  return call('', {
    method: 'POST',
    body: { fullName: name, companyName: name, role: 'supplier', ...extra },
  });
}

const FULL_TIN = '123456789';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

describe('TIN', () => {
  let id: string;

  it('is write-only: stored encrypted, shown as the last four digits, never in a response', async () => {
    const res = await createVendor({
      is1099Vendor: true,
      default1099Form: 'nec',
      default1099Box: 'nec_1',
      tinType: 'ein',
      tin: '12-3456789',
      w9: {
        legalName: 'Beta Roofing LLC',
        federalTaxClassification: 'llc',
        llcTaxClassification: 'S',
        receivedAt: '2026-01-15',
        signedName: 'Pat Beta',
        source: 'upload',
      },
      backupWithholding: false,
      taxUse: 'business',
    });
    expect(res.status).toBe(201);
    id = res.data.id;
    expect(res.data).toMatchObject({
      is1099Vendor: true,
      default1099Form: 'nec',
      default1099Box: 'nec_1',
      tinType: 'ein',
      tinLast4: '6789',
      tinMasked: '**-***6789',
      hasTin: true,
      taxUse: 'business',
      w9: { legalName: 'Beta Roofing LLC', federalTaxClassification: 'llc', llcTaxClassification: 'S' },
    });
    expect(res.text).not.toContain(FULL_TIN);
    expect(res.text).not.toContain('12-3456789');
    expect(res.text).not.toContain('sensitiveEncrypted');

    const [row] = await db.select().from(schema.parties).where(eq(schema.parties.id, id));
    expect(row!.sensitiveEncrypted).toBeTruthy();
    expect(row!.sensitiveEncrypted).not.toContain(FULL_TIN);
    expect(row!.tinLast4).toBe('6789');
  });

  it('stays out of list and detail responses, entity events and the audit log', async () => {
    await call(`/${id}`, { method: 'PATCH', body: { notes: 'Net 30', tin: '12-3456789', tinType: 'ein' } });
    const list = await call('');
    const detail = await call(`/${id}`);
    for (const res of [list, detail]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(FULL_TIN);
      expect(res.text).not.toContain('sensitiveEncrypted');
    }
    expect(detail.data).toMatchObject({ tinLast4: '6789', hasTin: true });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const text = JSON.stringify(event);
      expect(text).not.toContain(FULL_TIN);
      expect(text).not.toContain('sensitiveEncrypted');
      expect(event.data).not.toHaveProperty('tinLast4');
      expect(event.data).not.toHaveProperty('w9');
    }

    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(FULL_TIN);
  });

  it('is checked against its type, and a bad TIN leaves nothing behind', async () => {
    const before = await db.select().from(schema.parties);
    const badEin = await createVendor({ tinType: 'ein', tin: '00-1234567' }, 'Bad EIN Co');
    expect(badEin.status).toBe(400);
    expect(badEin.error?.message).toContain('EIN');
    const badSsn = await createVendor({ tinType: 'ssn', tin: '000-12-3456' }, 'Bad SSN Co');
    expect(badSsn.status).toBe(400);
    const noType = await createVendor({ tin: '12-3456789' }, 'No Type Co');
    expect(noType.status).toBe(400);
    expect(noType.error?.message).toContain('tinType');
    expect(await db.select().from(schema.parties)).toHaveLength(before.length);
  });

  it('a blank TIN field in a form post leaves the stored TIN alone; null removes it', async () => {
    const blank = await call(`/${id}`, { method: 'PATCH', body: { tin: '', notes: 'again' } });
    expect(blank.status).toBe(200);
    expect(blank.data.hasTin).toBe(true);

    const other = await createVendor({ tinType: 'ssn', tin: '123-45-6789' }, 'Sole Proprietor');
    expect(other.data).toMatchObject({ tinType: 'ssn', tinLast4: '6789', tinMasked: '***-**-6789' });
    const cleared = await call(`/${other.data.id}`, { method: 'PATCH', body: { tin: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.data).toMatchObject({ hasTin: false, tinLast4: null });
    const [row] = await db.select().from(schema.parties).where(eq(schema.parties.id, other.data.id));
    expect(row!.sensitiveEncrypted).toBeNull();
  });

  it('a new TIN clears the IRS match result; the same TIN does not', async () => {
    await db.update(schema.parties).set({ tinMatchStatus: 'match', tinMatchedAt: new Date() }).where(eq(schema.parties.id, id));
    const same = await call(`/${id}`, { method: 'PATCH', body: { tinType: 'ein', tin: '12-3456789' } });
    expect(same.data.tinMatchStatus).toBe('match');

    const changed = await call(`/${id}`, { method: 'PATCH', body: { tinType: 'ein', tin: '98-7654321' } });
    expect(changed.status).toBe(200);
    expect(changed.data).toMatchObject({ tinLast4: '4321', tinMatchStatus: null, tinMatchedAt: null });
  });

  it('refuses a type change without the TIN it belongs to', async () => {
    const res = await call(`/${id}`, { method: 'PATCH', body: { tinType: 'ssn' } });
    expect(res.status).toBe(400);
    expect(res.error?.message).toContain('TIN');
  });

  it('the TIN comes back only through reveal-tin: tax_ids:reveal, logged, uncached', async () => {
    const denied = await call(`/${id}/reveal-tin`, { method: 'POST', body: {} });
    expect(denied.status).toBe(403);
    expect(await db.select().from(schema.taxIdReveals)).toHaveLength(0);

    const res = await call(`/${id}/reveal-tin`, {
      method: 'POST',
      perms: ['tax_ids:reveal'],
      body: { reason: 'Checking the W-9' },
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ tin: '98-7654321', tinType: 'ein' });

    const trail = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(trail.map((r) => r.action)).toContain('tin_revealed');
    const [log] = await db.select().from(schema.taxIdReveals).orderBy(desc(schema.taxIdReveals.createdAt)).limit(1);
    expect(log).toMatchObject({
      subjectType: 'party',
      subjectId: id,
      field: 'tin',
      revealedBy: 'user_test_default',
      reason: 'Checking the W-9',
    });

    const none = await createVendor({}, 'No TIN Yet');
    const missing = await call(`/${none.data.id}/reveal-tin`, { method: 'POST', perms: ['tax_ids:reveal'], body: {} });
    expect(missing.status).toBe(404);
    expect(await db.select().from(schema.taxIdReveals)).toHaveLength(1);

    const history = await call(`/${id}/tax-id-reveals`, { perms: ['tax_ids:reveal'] });
    expect(history.status).toBe(200);
    expect(history.data).toHaveLength(1);
    expect(history.text).not.toContain('98-7654321');
  });
});

describe('ACH details', () => {
  let id: string;

  it('is write-only too, and entering it puts the vendor on hold until verified', async () => {
    const created = await createVendor({}, 'Gamma Supplies');
    id = created.data.id;
    expect(created.data.bankDetailsChangedAt).toBeNull();

    const res = await call(`/${id}`, {
      method: 'PATCH',
      body: { achRoutingNumber: '021000021', achAccountNumber: '0001 2345-6789', achAccountType: 'checking' },
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      achRoutingNumber: '021000021',
      achAccountLast4: '6789',
      achAccountType: 'checking',
      hasAchAccount: true,
      bankDetailsVerifiedAt: null,
      bankDetailsNeedVerification: true,
    });
    expect(res.data.bankDetailsChangedAt).toBeTruthy();
    expect(res.text).not.toContain('000123456789');
    expect(res.text).not.toContain('sensitiveEncrypted');

    const [row] = await db.select().from(schema.parties).where(eq(schema.parties.id, id));
    expect(row!.sensitiveEncrypted).not.toContain('6789');
    for (const event of events) expect(JSON.stringify(event)).not.toContain('000123456789');
    for (const event of events.filter((e) => e.entityId === id)) expect(event.data).not.toHaveProperty('achRoutingNumber');
  });

  it('checks the routing number', async () => {
    const res = await call(`/${id}`, { method: 'PATCH', body: { achRoutingNumber: '021000022' } });
    expect(res.status).toBe(400);
    expect(res.error?.message).toContain('Routing number');
    const bad = await call(`/${id}`, { method: 'PATCH', body: { achAccountNumber: '12' } });
    expect(bad.status).toBe(400);
  });

  it('verify-bank-details needs banking:manage and lifts the hold', async () => {
    const denied = await call(`/${id}/verify-bank-details`, { method: 'POST', body: {} });
    expect(denied.status).toBe(403);

    const res = await call(`/${id}/verify-bank-details`, { method: 'POST', perms: ['banking:manage'], body: {} });
    expect(res.status).toBe(200);
    expect(res.data.bankDetailsNeedVerification).toBe(false);
    expect(res.data.bankDetailsVerifiedAt).toBeTruthy();
    expect(res.data.bankDetailsVerifiedBy).toBe('user_test_default');
    // The audit trail records it (a failed audit write is swallowed by the route, so look for the row).
    const trail = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(trail.map((r) => r.action)).toContain('bank_verified');

    const empty = await createVendor({}, 'No Bank Co');
    const none = await call(`/${empty.data.id}/verify-bank-details`, { method: 'POST', perms: ['banking:manage'], body: {} });
    expect(none.status).toBe(400);
  });

  it('re-sending the same details changes nothing; a new account number clears the verification', async () => {
    const same = await call(`/${id}`, {
      method: 'PATCH',
      body: { achRoutingNumber: '021000021', achAccountNumber: '000123456789', achAccountType: 'checking' },
    });
    expect(same.data.bankDetailsVerifiedAt).toBeTruthy();
    expect(same.data.bankDetailsNeedVerification).toBe(false);

    const changed = await call(`/${id}`, { method: 'PATCH', body: { achAccountNumber: '555566667777' } });
    expect(changed.data).toMatchObject({ achAccountLast4: '7777', bankDetailsVerifiedAt: null, bankDetailsVerifiedBy: null, bankDetailsNeedVerification: true });

    const savings = await call(`/${id}/verify-bank-details`, { method: 'POST', perms: ['banking:manage'], body: {} });
    expect(savings.data.bankDetailsNeedVerification).toBe(false);
    const switched = await call(`/${id}`, { method: 'PATCH', body: { achAccountType: 'savings' } });
    expect(switched.data.bankDetailsNeedVerification).toBe(true);
  });

  it('the full account number comes back only through reveal-ach-account, logged', async () => {
    const denied = await call(`/${id}/reveal-ach-account`, { method: 'POST', body: {} });
    expect(denied.status).toBe(403);

    const res = await call(`/${id}/reveal-ach-account`, { method: 'POST', perms: ['tax_ids:reveal'], body: { reason: 'Call-back check' } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ achAccountNumber: '555566667777', achRoutingNumber: '021000021', achAccountType: 'savings' });

    const rows = await db.select().from(schema.taxIdReveals).where(eq(schema.taxIdReveals.field, 'ach_account_number'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: 'party', subjectId: id, reason: 'Call-back check' });
    const trail = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(trail.map((r) => r.action)).toContain('ach_account_revealed');
  });

  it('removing every detail leaves nothing to verify', async () => {
    const res = await call(`/${id}`, { method: 'PATCH', body: { achRoutingNumber: null, achAccountNumber: null, achAccountType: null } });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ hasAchAccount: false, achAccountLast4: null, bankDetailsChangedAt: null, bankDetailsNeedVerification: false });
  });
});

describe('1099 defaults and W-9', () => {
  it('validates the default box against the form', async () => {
    const bad = await createVendor({ default1099Form: 'nec', default1099Box: 'misc_1' }, 'Wrong Box Co');
    expect(bad.status).toBe(400);
    const unknown = await createVendor({ default1099Box: 'nec_9' }, 'Unknown Box Co');
    expect(unknown.status).toBe(400);
    const omit = await createVendor({ default1099Box: 'omit' }, 'Omit Co');
    expect(omit.status).toBe(201);
    expect(omit.data.default1099Box).toBe('omit');
  });

  it('keeps W-9 fields across partial updates and clears a blank one', async () => {
    const created = await createVendor({ w9: { legalName: 'Delta Design LLC', federalTaxClassification: 'llc', llcTaxClassification: 'C' } }, 'Delta Design');
    const id = created.data.id;
    const patched = await call(`/${id}`, { method: 'PATCH', body: { w9: { receivedAt: '2026-03-01', isAttorney: false } } });
    expect(patched.data.w9).toMatchObject({ legalName: 'Delta Design LLC', llcTaxClassification: 'C', receivedAt: '2026-03-01' });

    const needsLetter = await call(`/${id}`, { method: 'PATCH', body: { w9: { federalTaxClassification: 'llc', llcTaxClassification: undefined } } });
    expect(needsLetter.status).toBe(200);
    const llcWithoutLetter = await createVendor({ w9: { federalTaxClassification: 'llc' } }, 'No Letter LLC');
    expect(llcWithoutLetter.status).toBe(400);
  });

  it('links the scanned W-9 to an accounting document that exists', async () => {
    const now = new Date();
    await db.insert(schema.documents).values({ id: 'doc_w9scan', type: 'w9', fileName: 'w9.pdf', fileKey: 'docs/w9.pdf', createdAt: now, updatedAt: now });
    const created = await createVendor({}, 'Foxtrot Freight');
    const ok = await call(`/${created.data.id}`, { method: 'PATCH', body: { w9: { documentId: 'doc_w9scan', source: 'upload' } } });
    expect(ok.status).toBe(200);
    expect(ok.data.w9).toMatchObject({ documentId: 'doc_w9scan', source: 'upload' });
    const missing = await call(`/${created.data.id}`, { method: 'PATCH', body: { w9: { documentId: 'doc_nope' } } });
    expect(missing.status).toBe(400);
    expect(missing.error?.message).toContain('doc_nope');
  });

  it('records and withdraws e-delivery consent', async () => {
    const created = await createVendor({ form1099EDeliveryConsentAt: '2026-02-01T10:00:00Z' }, 'Epsilon Consulting');
    expect(created.data.form1099EDeliveryConsentAt).toBe('2026-02-01T10:00:00.000Z');
    const withdrawn = await call(`/${created.data.id}`, { method: 'PATCH', body: { form1099EDeliveryConsentAt: null } });
    expect(withdrawn.data.form1099EDeliveryConsentAt).toBeNull();
  });
});
