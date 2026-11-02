/**
 * Route tests for WeldHR expense declarations (/declarations, receipts
 * included) and sick reports (/absences) in the back office, against a real
 * pglite tenant database through the whole /api/weldhr router.
 *
 * These are the requests the Rust port (rust/modules/hr) is compared on in
 * conformance mode, refusals included. Receipts live in an in-memory R2
 * bucket at `STORAGE`, which conformance mode shares with the Rust server.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { workingDaysBetween } from '../../services/weldhr/shared';
import {
  HR_ADMIN,
  HR_ORG,
  daysFromToday,
  data,
  errorOf,
  hrCaller,
  hrDb,
  resetHr,
  seedDepartment,
  seedEmployee,
  seedMember,
  today,
} from '../../test/hr-fixtures';

let db: Database;
let bucket: R2Bucket;

beforeAll(async () => {
  db = await hrDb();
}, 60_000);

beforeEach(async () => {
  bucket = createMemoryR2();
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_anna', { name: 'Anna Self', email: 'anna@example.com' });
  await seedDepartment(db, 'hrdep_ops', 'Operations');
  await seedDepartment(db, 'hrdep_sales', 'Sales');
  await seedEmployee(db, { id: 'hremp_ann', userId: 'user_anna', email: 'anna@example.com', firstName: 'Ann', departmentId: 'hrdep_ops' });
  await seedEmployee(db, { id: 'hremp_ben', email: 'ben@example.com', firstName: 'Ben', departmentId: 'hrdep_sales' });
  await seedEmployee(db, { id: 'hremp_gone', email: 'gone@example.com', firstName: 'Gone', deletedAt: new Date('2026-01-10T00:00:00Z') });
});

const admin = () => hrCaller(db, { env: { STORAGE: bucket } });
const as = (...grants: string[]) => hrCaller(db, { grants, env: { STORAGE: bucket } });

function pdf(name = 'receipt.pdf', text = '%PDF-1.4 receipt') {
  return new File([new TextEncoder().encode(text)], name, { type: 'application/pdf' });
}

async function receiptKeys(declarationId: string) {
  const listed = await bucket.list({ prefix: `workspaces/${HR_ORG}/hr/declarations/${declarationId}/` });
  return listed.objects.map((o) => o.key);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

async function seedDeclaration(id: string, fields: Partial<typeof schema.hrDeclarations.$inferInsert> = {}) {
  await db.insert(schema.hrDeclarations).values({
    id,
    employeeId: 'hremp_ann',
    expenseDate: '2026-03-10',
    category: 'travel',
    description: `Expense ${id}`,
    amount: '10.00',
    status: 'pending',
    submittedBy: HR_ADMIN,
    createdAt: new Date('2026-03-11T08:00:00.000Z'),
    updatedAt: new Date('2026-03-11T08:00:00.000Z'),
    ...fields,
  });
}

async function declarationRow(id: string) {
  const [row] = await db.select().from(schema.hrDeclarations).where(eq(schema.hrDeclarations.id, id));
  return row;
}

describe('GET /declarations', () => {
  beforeEach(async () => {
    await seedDeclaration('hrdcl_d1', { amount: '12.50' });
    await seedDeclaration('hrdcl_d2', {
      employeeId: 'hremp_ben',
      expenseDate: '2026-03-12',
      category: 'meals',
      amount: '8.00',
      status: 'approved',
      reviewedBy: HR_ADMIN,
      reviewedAt: new Date('2026-03-13T09:00:00.000Z'),
      reviewNote: 'Fine',
    });
    await seedDeclaration('hrdcl_d3', { expenseDate: '2026-03-01', category: 'other', status: 'paid', amount: '99.99' });
    await seedDeclaration('hrdcl_d4', { employeeId: 'hremp_gone', expenseDate: '2026-03-05' });
  });

  it('lists declarations by expense date, newest first, with names and amounts as numbers', async () => {
    const res = await admin().get('/declarations');
    expect(res.status).toBe(200);
    const rows = await data<Array<Record<string, unknown>>>(res);
    expect(rows.map((r) => r.id)).toEqual(['hrdcl_d2', 'hrdcl_d1', 'hrdcl_d3']);
    expect(rows[0]).toMatchObject({ employeeName: 'Ben Example', reviewedByName: 'Hanna Admin', amount: 8, status: 'approved' });
    expect(rows[1]).toMatchObject({ employeeName: 'Ann Example', reviewedByName: null, amount: 12.5, currency: 'EUR', hasReceipt: false });
    expect(rows[2]!.amount).toBe(99.99);
    expect(rows[1]).not.toHaveProperty('receiptFileKey');
  });

  it('filters by employee, status, category and expense dates', async () => {
    const ids = async (query: string) => (await data<Array<{ id: string }>>(await admin().get(`/declarations${query}`))).map((r) => r.id);
    expect(await ids('?employeeId=hremp_ann')).toEqual(['hrdcl_d1', 'hrdcl_d3']);
    expect(await ids('?status=pending,paid')).toEqual(['hrdcl_d1', 'hrdcl_d3']);
    expect(await ids('?category=meals')).toEqual(['hrdcl_d2']);
    expect(await ids('?from=2026-03-05&to=2026-03-11')).toEqual(['hrdcl_d1']);
    // A date that is not YYYY-MM-DD is ignored.
    expect(await ids('?from=yesterday')).toEqual(['hrdcl_d2', 'hrdcl_d1', 'hrdcl_d3']);
  });

  it('needs declarations:read', async () => {
    expect((await as('declarations:create').get('/declarations')).status).toBe(403);
  });
});

describe('POST /declarations', () => {
  it('files a pending declaration in euros by default', async () => {
    const res = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_ann',
      expenseDate: daysFromToday(-2),
      category: 'travel',
      description: 'Train to Ghent',
      amount: 23.4,
    });
    expect(res.status).toBe(201);
    const body = await data<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      employeeId: 'hremp_ann',
      expenseDate: daysFromToday(-2),
      category: 'travel',
      description: 'Train to Ghent',
      amount: 23.4,
      currency: 'EUR',
      status: 'pending',
      hasReceipt: false,
      receiptFileName: null,
      submittedBy: HR_ADMIN,
      reviewedBy: null,
      paidAt: null,
    });
    expect(body).not.toHaveProperty('receiptFileKey');
    expect((await declarationRow(body.id as string))!.amount).toBe('23.40');
  });

  it('accepts tomorrow (a client east of UTC) and another currency', async () => {
    const res = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_ben',
      expenseDate: daysFromToday(1),
      category: 'equipment',
      description: 'Headset',
      amount: 1000000,
      currency: 'USD',
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ amount: 1000000, currency: 'USD' });
  });

  it('answers readable validation messages', async () => {
    const res = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_ann',
      expenseDate: 'yesterday',
      category: 'food',
      description: '   ',
      amount: 12.345,
    });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(
      'Expense date: Expected YYYY-MM-DD. Category must be one of travel, meals, accommodation, equipment, training, other. Description is required. Amount: Use at most two decimals',
    );

    const negative = await admin().send('POST', '/declarations', {
      expenseDate: today(),
      category: 'meals',
      description: 'Lunch',
      amount: -5,
      currency: 'JPY',
    });
    expect(negative.status).toBe(400);
    expect((await errorOf(negative)).message).toBe('Employee id is required. Amount must be more than 0. Currency must be one of EUR, USD, GBP');

    const huge = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_ann',
      expenseDate: today(),
      category: 'meals',
      description: 'Lunch',
      amount: 1000001,
    });
    expect((await errorOf(huge)).message).toBe('Amount must be at most 1000000');
  });

  it('refuses a future expense date and an unknown employee', async () => {
    const future = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_ann',
      expenseDate: daysFromToday(2),
      category: 'meals',
      description: 'Dinner',
      amount: 30,
    });
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe('The expense date cannot be in the future');

    const unknown = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_nope',
      expenseDate: today(),
      category: 'meals',
      description: 'Dinner',
      amount: 30,
    });
    expect(unknown.status).toBe(404);
    expect(await errorOf(unknown)).toEqual({ code: 'NOT_FOUND', message: "Employee with ID 'hremp_nope' not found" });

    const deleted = await admin().send('POST', '/declarations', {
      employeeId: 'hremp_gone',
      expenseDate: today(),
      category: 'meals',
      description: 'Dinner',
      amount: 30,
    });
    expect(deleted.status).toBe(404);
  });

  it('needs declarations:create', async () => {
    const res = await as('declarations:read', 'declarations:update').send('POST', '/declarations', {
      employeeId: 'hremp_ann',
      expenseDate: today(),
      category: 'meals',
      description: 'Lunch',
      amount: 5,
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('FORBIDDEN');
  });
});

describe('PATCH /declarations/:declarationId', () => {
  beforeEach(async () => {
    await seedDeclaration('hrdcl_p1');
    await seedDeclaration('hrdcl_p2', { status: 'approved' });
  });

  it('changes a pending declaration', async () => {
    const res = await admin().send('PATCH', '/declarations/hrdcl_p1', { amount: 15, description: 'Updated', category: 'meals', currency: 'GBP' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ id: 'hrdcl_p1', amount: 15, description: 'Updated', category: 'meals', currency: 'GBP', expenseDate: '2026-03-10' });
    expect((await declarationRow('hrdcl_p1'))!.amount).toBe('15.00');
  });

  it('refuses a declaration that is no longer pending, a future date and bad input', async () => {
    const decided = await admin().send('PATCH', '/declarations/hrdcl_p2', { amount: 15 });
    expect(decided.status).toBe(409);
    expect(await errorOf(decided)).toMatchObject({ code: 'CONFLICT', message: 'This declaration is already approved and can no longer be changed' });

    const future = await admin().send('PATCH', '/declarations/hrdcl_p1', { expenseDate: daysFromToday(3) });
    expect(future.status).toBe(400);
    expect((await errorOf(future)).message).toBe('The expense date cannot be in the future');

    const invalid = await admin().send('PATCH', '/declarations/hrdcl_p1', { amount: 0.001 });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Amount: Use at most two decimals');
  });

  it('is a 404 for an unknown declaration and needs declarations:update', async () => {
    expect((await admin().send('PATCH', '/declarations/hrdcl_nope', { amount: 5 })).status).toBe(404);
    expect((await as('declarations:create').send('PATCH', '/declarations/hrdcl_p1', { amount: 5 })).status).toBe(403);
  });
});

describe('POST /declarations/:declarationId/review', () => {
  beforeEach(async () => {
    await seedDeclaration('hrdcl_r1');
    await seedDeclaration('hrdcl_r2');
  });

  it('approves or rejects a pending declaration', async () => {
    const approved = await admin().send('POST', '/declarations/hrdcl_r1/review', { decision: 'approved', note: 'OK' });
    expect(approved.status).toBe(200);
    const body = await data<{ reviewedAt: string | null }>(approved);
    expect(body).toMatchObject({ id: 'hrdcl_r1', status: 'approved', reviewNote: 'OK', reviewedBy: HR_ADMIN });
    expect(body.reviewedAt).not.toBeNull();

    const rejected = await admin().send('POST', '/declarations/hrdcl_r2/review', { decision: 'rejected' });
    expect(rejected.status).toBe(200);
    expect(await data(rejected)).toMatchObject({ status: 'rejected', reviewNote: null });

    const again = await admin().send('POST', '/declarations/hrdcl_r1/review', { decision: 'rejected' });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toBe('This declaration is already approved');
  });

  it('validates the decision, is a 404 for an unknown declaration and needs declarations:approve', async () => {
    const invalid = await admin().send('POST', '/declarations/hrdcl_r1/review', { decision: 'maybe' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Decision must be one of approved, rejected');
    expect((await admin().send('POST', '/declarations/hrdcl_nope/review', { decision: 'approved' })).status).toBe(404);
    expect((await as('declarations:update').send('POST', '/declarations/hrdcl_r1/review', { decision: 'approved' })).status).toBe(403);
  });
});

describe('POST /declarations/:declarationId/pay', () => {
  it('marks an approved declaration as paid, and only an approved one', async () => {
    await seedDeclaration('hrdcl_y1', { status: 'approved' });
    await seedDeclaration('hrdcl_y2');
    const paid = await admin().send('POST', '/declarations/hrdcl_y1/pay');
    expect(paid.status).toBe(200);
    const body = await data<{ paidAt: string | null }>(paid);
    expect(body).toMatchObject({ status: 'paid', paidBy: HR_ADMIN });
    expect(body.paidAt).not.toBeNull();

    for (const id of ['hrdcl_y1', 'hrdcl_y2']) {
      const refused = await admin().send('POST', `/declarations/${id}/pay`);
      expect(refused.status).toBe(409);
      expect((await errorOf(refused)).message).toBe('Only an approved declaration can be marked as paid');
    }
    expect((await admin().send('POST', '/declarations/hrdcl_nope/pay')).status).toBe(404);
    expect((await as('declarations:update').send('POST', '/declarations/hrdcl_y2/pay')).status).toBe(403);
  });
});

describe('POST /declarations/:declarationId/cancel', () => {
  it('withdraws a pending or approved declaration, never a paid one', async () => {
    await seedDeclaration('hrdcl_c1');
    await seedDeclaration('hrdcl_c2', { status: 'approved' });
    await seedDeclaration('hrdcl_c3', { status: 'paid' });
    for (const id of ['hrdcl_c1', 'hrdcl_c2']) {
      const res = await admin().send('POST', `/declarations/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(await data(res)).toMatchObject({ id, status: 'cancelled' });
    }
    const paid = await admin().send('POST', '/declarations/hrdcl_c3/cancel');
    expect(paid.status).toBe(409);
    expect((await errorOf(paid)).message).toBe('This declaration is already paid');
    const cancelled = await admin().send('POST', '/declarations/hrdcl_c1/cancel');
    expect((await errorOf(cancelled)).message).toBe('This declaration is already cancelled');
    expect((await admin().send('POST', '/declarations/hrdcl_nope/cancel')).status).toBe(404);
    expect((await as('declarations:approve').send('POST', '/declarations/hrdcl_c3/cancel')).status).toBe(403);
  });
});

describe('DELETE /declarations/:declarationId', () => {
  it('removes the row, and the receipt after the response', async () => {
    await seedDeclaration('hrdcl_x1');
    expect((await admin().upload('/declarations/hrdcl_x1/receipt', pdf())).status).toBe(200);
    expect(await receiptKeys('hrdcl_x1')).toHaveLength(1);

    const res = await admin().send('DELETE', '/declarations/hrdcl_x1');
    expect(res.status).toBe(204);
    expect(await declarationRow('hrdcl_x1')).toBeUndefined();
    await vi.waitFor(async () => expect(await receiptKeys('hrdcl_x1')).toEqual([]), { timeout: 5000 });
    expect((await admin().send('DELETE', '/declarations/hrdcl_x1')).status).toBe(404);
  });

  it('needs declarations:delete', async () => {
    await seedDeclaration('hrdcl_x2');
    expect((await as('declarations:update', 'declarations:approve').send('DELETE', '/declarations/hrdcl_x2')).status).toBe(403);
  });
});

describe('POST /declarations/:declarationId/receipt', () => {
  beforeEach(async () => {
    await seedDeclaration('hrdcl_u1');
    await seedDeclaration('hrdcl_u2', { status: 'approved' });
  });

  it('stores the receipt under the workspace, with a safe file name', async () => {
    const res = await admin().upload('/declarations/hrdcl_u1/receipt', pdf('taxi ride (May).pdf', '%PDF-1.4 taxi'));
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      id: 'hrdcl_u1',
      hasReceipt: true,
      receiptFileName: 'taxi_ride__May_.pdf',
      receiptContentType: 'application/pdf',
      receiptSize: 13,
      status: 'pending',
    });
    const keys = await receiptKeys('hrdcl_u1');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^workspaces\/org_hr_test\/hr\/declarations\/hrdcl_u1\/[0-9a-f]{32}\/taxi_ride__May_\.pdf$/);
  });

  it('replaces an earlier receipt and removes its object', async () => {
    await admin().upload('/declarations/hrdcl_u1/receipt', pdf('first.pdf'));
    const [first] = await receiptKeys('hrdcl_u1');
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'photo.png', { type: 'image/png' });
    const res = await admin().upload('/declarations/hrdcl_u1/receipt', png);
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ receiptFileName: 'photo.png', receiptContentType: 'image/png', receiptSize: 7 });
    const keys = await receiptKeys('hrdcl_u1');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(first);
    expect(keys[0]!.endsWith('/photo.png')).toBe(true);
  });

  it('accepts the create grant as well as the update one', async () => {
    expect((await as('declarations:create').upload('/declarations/hrdcl_u1/receipt', pdf())).status).toBe(200);
    expect((await as('declarations:update').upload('/declarations/hrdcl_u1/receipt', pdf())).status).toBe(200);
    expect((await as('declarations:read', 'declarations:approve').upload('/declarations/hrdcl_u1/receipt', pdf())).status).toBe(403);
  });

  it('refuses another file type, an empty file and a missing file field', async () => {
    const text = await admin().upload('/declarations/hrdcl_u1/receipt', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(text.status).toBe(400);
    expect((await errorOf(text)).message).toBe('A receipt must be a JPEG, PNG or WebP image, or a PDF');

    const empty = await admin().upload('/declarations/hrdcl_u1/receipt', new File([], 'empty.pdf', { type: 'application/pdf' }));
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).message).toBe('The receipt file is empty');

    const missing = await admin().upload('/declarations/hrdcl_u1/receipt', 'not a file');
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).message).toBe('Send the receipt as a multipart "file" field');
    expect(await receiptKeys('hrdcl_u1')).toEqual([]);
  });

  it('refuses a declaration that is no longer pending, and an unknown one', async () => {
    const decided = await admin().upload('/declarations/hrdcl_u2/receipt', pdf());
    expect(decided.status).toBe(409);
    expect((await errorOf(decided)).message).toBe('This declaration is already approved and its receipt can no longer be changed');
    expect((await admin().upload('/declarations/hrdcl_nope/receipt', pdf())).status).toBe(404);
  });
});

describe('GET /declarations/:declarationId/receipt', () => {
  beforeEach(async () => {
    await seedDeclaration('hrdcl_g1');
    await seedDeclaration('hrdcl_g2');
  });

  it('streams the stored receipt as a private inline file', async () => {
    await admin().upload('/declarations/hrdcl_g1/receipt', pdf('scan "1".pdf', '%PDF-1.4 the receipt'));
    const res = await admin().get('/declarations/hrdcl_g1/receipt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe('inline; filename="scan__1_.pdf"');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('%PDF-1.4 the receipt');
  });

  it('is a 404 without a receipt, when the object is gone, or outside the workspace', async () => {
    expect((await admin().get('/declarations/hrdcl_g2/receipt')).status).toBe(404);
    expect((await admin().get('/declarations/hrdcl_nope/receipt')).status).toBe(404);

    await admin().upload('/declarations/hrdcl_g1/receipt', pdf());
    const [key] = await receiptKeys('hrdcl_g1');
    await bucket.delete(key!);
    const gone = await admin().get('/declarations/hrdcl_g1/receipt');
    expect(gone.status).toBe(404);
    expect(await errorOf(gone)).toEqual({ code: 'NOT_FOUND', message: "Receipt with ID 'hrdcl_g1' not found" });

    const foreign = 'workspaces/org_other/hr/declarations/hrdcl_g2/abc/receipt.pdf';
    await bucket.put(foreign, new TextEncoder().encode('%PDF'), { httpMetadata: { contentType: 'application/pdf' } });
    await db
      .update(schema.hrDeclarations)
      .set({ receiptFileKey: foreign, receiptFileName: 'receipt.pdf', receiptContentType: 'application/pdf', receiptSize: 4 })
      .where(eq(schema.hrDeclarations.id, 'hrdcl_g2'));
    expect((await admin().get('/declarations/hrdcl_g2/receipt')).status).toBe(404);
  });

  it('needs declarations:read', async () => {
    expect((await as('declarations:create', 'declarations:update').get('/declarations/hrdcl_g1/receipt')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Absences (sick reports)
// ---------------------------------------------------------------------------

async function seedAbsence(id: string, fields: Partial<typeof schema.hrAbsences.$inferInsert> & { employeeId: string; startDate: string }) {
  await db.insert(schema.hrAbsences).values({
    id,
    createdAt: new Date('2026-02-09T08:00:00.000Z'),
    updatedAt: new Date('2026-02-09T08:00:00.000Z'),
    ...fields,
  });
}

async function absenceRow(id: string) {
  const [row] = await db.select().from(schema.hrAbsences).where(eq(schema.hrAbsences.id, id));
  return row;
}

describe('GET /absences', () => {
  beforeEach(async () => {
    // 2026-02-09 and 2026-03-02 are Mondays.
    await seedAbsence('hrabs_a1', { employeeId: 'hremp_ann', startDate: '2026-02-09', endDate: '2026-02-13', reportedBy: 'user_anna' });
    await seedAbsence('hrabs_a2', {
      employeeId: 'hremp_ann',
      startDate: '2026-03-02',
      endDate: '2026-03-08',
      firstDay: 'half',
      note: 'Reachable by phone',
      reportedBy: HR_ADMIN,
      recoveredReportedBy: HR_ADMIN,
      recoveredReportedAt: new Date('2026-03-09T08:00:00.000Z'),
    });
    await seedAbsence('hrabs_a3', { employeeId: 'hremp_ben', startDate: daysFromToday(-3), reportedBy: 'portal:hremp_ben' });
    await seedAbsence('hrabs_a4', { employeeId: 'hremp_gone', startDate: daysFromToday(-1) });
  });

  it('lists reports newest first with status, days, relapse and who filed them', async () => {
    const res = await admin().get('/absences');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data.map((r) => r.id)).toEqual(['hrabs_a3', 'hrabs_a2', 'hrabs_a1']);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
    expect(body.data[0]).toMatchObject({
      employeeName: 'Ben Example',
      departmentName: 'Sales',
      status: 'ongoing',
      endDate: null,
      days: workingDaysBetween(daysFromToday(-3), today()),
      relapse: false,
      reportedBySelf: true,
      reportedByName: null,
    });
    expect(body.data[1]).toMatchObject({
      employeeName: 'Ann Example',
      departmentName: 'Operations',
      status: 'completed',
      firstDay: 'half',
      days: 4.5,
      relapse: true,
      reportedBySelf: false,
      reportedByName: 'Hanna Admin',
      note: 'Reachable by phone',
    });
    expect(body.data[2]).toMatchObject({ status: 'completed', days: 5, relapse: false, reportedBySelf: true, reportedByName: null });
  });

  it('filters by status, employee and department, and pages with a cursor', async () => {
    const caller = admin();
    const ids = async (query: string) => (await data<Array<{ id: string }>>(await caller.get(`/absences${query}`))).map((r) => r.id);
    expect(await ids('?status=ongoing')).toEqual(['hrabs_a3']);
    expect(await ids('?status=completed')).toEqual(['hrabs_a2', 'hrabs_a1']);
    expect(await ids('?status=whatever')).toEqual(['hrabs_a3', 'hrabs_a2', 'hrabs_a1']);
    expect(await ids('?employeeId=hremp_ann')).toEqual(['hrabs_a2', 'hrabs_a1']);
    expect(await ids('?departmentId=hrdep_sales')).toEqual(['hrabs_a3']);

    const first = (await (await caller.get('/absences?limit=2')).json()) as {
      data: Array<{ id: string }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string };
    };
    expect(first.data.map((r) => r.id)).toEqual(['hrabs_a3', 'hrabs_a2']);
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'hrabs_a2' });
    expect(await ids(`?limit=2&cursor=${first.pagination.cursor}`)).toEqual(['hrabs_a1']);
  });

  it('needs absences:read', async () => {
    expect((await as('absences:create', 'leave:read').get('/absences')).status).toBe(403);
  });
});

describe('POST /absences', () => {
  it('files a closed report on behalf of an employee', async () => {
    const res = await admin().send('POST', '/absences', {
      employeeId: 'hremp_ben',
      startDate: '2026-04-06',
      endDate: '2026-04-07',
      note: '  Call after 3  ',
    });
    expect(res.status).toBe(201);
    const body = await data<{ recoveredReportedAt: string | null }>(res);
    expect(body).toMatchObject({
      employeeId: 'hremp_ben',
      startDate: '2026-04-06',
      endDate: '2026-04-07',
      firstDay: 'full',
      note: 'Call after 3',
      reportedBy: HR_ADMIN,
      recoveredReportedBy: HR_ADMIN,
    });
    expect(body.recoveredReportedAt).not.toBeNull();
  });

  it('files an open report, and refuses a second open one or an overlap', async () => {
    const open = await admin().send('POST', '/absences', { employeeId: 'hremp_ann', startDate: daysFromToday(-1), firstDay: 'half', note: '  ' });
    expect(open.status).toBe(201);
    expect(await data(open)).toMatchObject({ endDate: null, firstDay: 'half', note: null, recoveredReportedBy: null, recoveredReportedAt: null });

    const second = await admin().send('POST', '/absences', { employeeId: 'hremp_ann', startDate: daysFromToday(-10) });
    expect(second.status).toBe(409);
    expect((await errorOf(second)).message).toBe('There is already an open sick report');

    await seedAbsence('hrabs_o1', { employeeId: 'hremp_ben', startDate: '2026-04-06', endDate: '2026-04-07' });
    const overlap = await admin().send('POST', '/absences', { employeeId: 'hremp_ben', startDate: '2026-04-07', endDate: '2026-04-09' });
    expect(overlap.status).toBe(409);
    expect((await errorOf(overlap)).message).toBe('This overlaps another sick report');
  });

  it('refuses dates out of order, bad input, an unknown employee and a caller without absences:create', async () => {
    const order = await admin().send('POST', '/absences', { employeeId: 'hremp_ben', startDate: '2026-04-07', endDate: '2026-04-06' });
    expect(order.status).toBe(400);
    expect((await errorOf(order)).message).toBe('Sick report: end date is before start date');

    const invalid = await admin().send('POST', '/absences', { employeeId: 'hremp_ann', startDate: '2026-4-1', firstDay: 'quarter' });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('Start date: Expected YYYY-MM-DD. First day must be one of full, half');

    expect((await admin().send('POST', '/absences', { employeeId: 'hremp_nope', startDate: '2026-04-01' })).status).toBe(404);
    expect((await as('absences:read', 'absences:update').send('POST', '/absences', { employeeId: 'hremp_ann', startDate: '2026-04-01' })).status).toBe(403);
  });
});

describe('PATCH /absences/:absenceId', () => {
  beforeEach(async () => {
    await seedAbsence('hrabs_p1', { employeeId: 'hremp_ann', startDate: '2026-02-09', endDate: '2026-02-13', reportedBy: 'user_anna' });
    await seedAbsence('hrabs_p2', {
      employeeId: 'hremp_ann',
      startDate: '2026-03-02',
      endDate: '2026-03-04',
      note: 'Old note',
      reportedBy: HR_ADMIN,
      recoveredReportedBy: 'user_anna',
      recoveredReportedAt: new Date('2026-03-05T08:00:00.000Z'),
    });
    await seedAbsence('hrabs_p3', { employeeId: 'hremp_ben', startDate: daysFromToday(-2), reportedBy: HR_ADMIN });
  });

  it('closes an open report and records who reported the recovery', async () => {
    const res = await admin().send('PATCH', '/absences/hrabs_p3', { endDate: today(), note: 'Back at work' });
    expect(res.status).toBe(200);
    const body = await data<{ recoveredReportedAt: string | null }>(res);
    expect(body).toMatchObject({ endDate: today(), note: 'Back at work', recoveredReportedBy: HR_ADMIN });
    expect(body.recoveredReportedAt).not.toBeNull();
  });

  it('reopens a closed report and clears who reported the recovery', async () => {
    const res = await admin().send('PATCH', '/absences/hrabs_p2', { endDate: null, note: null, firstDay: 'half' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({
      startDate: '2026-03-02',
      endDate: null,
      note: null,
      firstDay: 'half',
      recoveredReportedBy: null,
      recoveredReportedAt: null,
    });
  });

  it('keeps who reported the recovery when only the dates of a closed report move', async () => {
    const res = await admin().send('PATCH', '/absences/hrabs_p2', { endDate: '2026-03-05' });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ endDate: '2026-03-05', note: 'Old note', recoveredReportedBy: 'user_anna' });
  });

  it('refuses an overlap, dates out of order, an unknown report and a caller without absences:update', async () => {
    const overlap = await admin().send('PATCH', '/absences/hrabs_p1', { endDate: '2026-03-03' });
    expect(overlap.status).toBe(409);
    expect((await errorOf(overlap)).message).toBe('This overlaps another sick report');

    const order = await admin().send('PATCH', '/absences/hrabs_p1', { startDate: '2026-02-20' });
    expect(order.status).toBe(400);
    expect((await errorOf(order)).message).toBe('Sick report: end date is before start date');

    expect((await admin().send('PATCH', '/absences/hrabs_nope', { note: 'x' })).status).toBe(404);
    expect((await as('absences:read', 'absences:create').send('PATCH', '/absences/hrabs_p1', { note: 'x' })).status).toBe(403);
  });
});

describe('POST /absences/:absenceId/recover', () => {
  beforeEach(async () => {
    await seedAbsence('hrabs_r1', { employeeId: 'hremp_ann', startDate: '2026-02-09', endDate: '2026-02-13' });
    await seedAbsence('hrabs_r2', { employeeId: 'hremp_ben', startDate: daysFromToday(-4), reportedBy: 'portal:hremp_ben' });
  });

  it('closes an open report, even with a last sick day ahead (HR knows best)', async () => {
    const res = await admin().send('POST', '/absences/hrabs_r2/recover', { endDate: daysFromToday(2) });
    expect(res.status).toBe(200);
    const body = await data<{ recoveredReportedAt: string | null }>(res);
    expect(body).toMatchObject({ id: 'hrabs_r2', endDate: daysFromToday(2), recoveredReportedBy: HR_ADMIN, reportedBy: 'portal:hremp_ben' });
    expect(body.recoveredReportedAt).not.toBeNull();
  });

  it('refuses a closed report, a last day before the first, bad input and an unknown report', async () => {
    const closed = await admin().send('POST', '/absences/hrabs_r1/recover', { endDate: today() });
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).message).toBe('This sick report is already closed');

    const order = await admin().send('POST', '/absences/hrabs_r2/recover', { endDate: daysFromToday(-10) });
    expect(order.status).toBe(400);
    expect((await errorOf(order)).message).toBe('Sick report: end date is before start date');

    const invalid = await admin().send('POST', '/absences/hrabs_r2/recover', {});
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).message).toBe('End date is required');

    expect((await admin().send('POST', '/absences/hrabs_nope/recover', { endDate: today() })).status).toBe(404);
    expect((await as('absences:create', 'absences:read').send('POST', '/absences/hrabs_r2/recover', { endDate: today() })).status).toBe(403);
  });
});

describe('DELETE /absences/:absenceId', () => {
  it('removes the report', async () => {
    await seedAbsence('hrabs_x1', { employeeId: 'hremp_ann', startDate: '2026-02-09', endDate: '2026-02-13' });
    expect((await as('absences:update').send('DELETE', '/absences/hrabs_x1')).status).toBe(403);
    expect((await admin().send('DELETE', '/absences/hrabs_x1')).status).toBe(204);
    expect(await absenceRow('hrabs_x1')).toBeUndefined();
    expect((await admin().send('DELETE', '/absences/hrabs_x1')).status).toBe(404);
  });
});
