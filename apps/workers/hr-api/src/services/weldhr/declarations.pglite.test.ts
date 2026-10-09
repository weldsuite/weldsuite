/**
 * Service tests for expense declarations: the status flow, what an employee
 * may do to their own declaration, and the receipt object behind it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  attachDeclarationReceipt,
  cancelDeclaration,
  createDeclaration,
  deleteDeclaration,
  employeeDeclarations,
  listDeclarations,
  loadDeclarationReceipt,
  markDeclarationPaid,
  reviewDeclaration,
  toPublicDeclaration,
  updateDeclaration,
} from './declarations';
import { HrConflictError, HrNotFoundError, HrValidationError, addDays, todayIso } from './shared';

const WORKSPACE = 'ws_test';
const ALICE = 'hremp_alice';
const BOB = 'hremp_bob';

let db: Database;

/** The slice of R2Bucket the service uses, backed by a Map. */
function fakeBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType?: string }>();
  const bucket = {
    async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const found = objects.get(key);
      return found ? { body: new Blob([found.bytes]).stream() } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

function expense(overrides: Partial<{ expenseDate: string; amount: number; currency: string }> = {}) {
  return {
    expenseDate: todayIso(),
    category: 'travel',
    description: 'Train to the client',
    amount: 42.5,
    ...overrides,
  };
}

function receipt(name = 'ticket.pdf', type = 'application/pdf', size = 4) {
  return new File([new Uint8Array(size)], name, { type });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.hrEmployees).values([
    { id: ALICE, firstName: 'Alice', lastName: 'Example', email: 'alice@example.com' },
    { id: BOB, firstName: 'Bob', lastName: 'Example', email: 'bob@example.com' },
  ]);
}, 60_000);

describe('filing a declaration', () => {
  it('starts pending and keeps the amount to the cent', async () => {
    const row = await createDeclaration(db, { employeeId: ALICE, ...expense({ amount: 19.99 }) }, 'user_hr');
    expect(row.status).toBe('pending');
    expect(row.currency).toBe('EUR');
    expect(toPublicDeclaration(row).amount).toBe(19.99);
    expect(toPublicDeclaration(row)).not.toHaveProperty('receiptFileKey');
  });

  it('refuses an expense dated in the future and an unknown employee', async () => {
    await expect(
      createDeclaration(db, { employeeId: ALICE, ...expense({ expenseDate: addDays(todayIso(), 2) }) }, 'user_hr'),
    ).rejects.toBeInstanceOf(HrValidationError);
    await expect(createDeclaration(db, { employeeId: 'hremp_nobody', ...expense() }, 'user_hr')).rejects.toBeInstanceOf(
      HrNotFoundError,
    );
  });

  it('lists with the employee name and filters by status', async () => {
    const row = await createDeclaration(db, { employeeId: BOB, ...expense() }, 'user_hr');
    await reviewDeclaration(db, row.id, { decision: 'rejected', note: 'No receipt' }, 'user_hr');
    const rejected = await listDeclarations(db, { status: 'rejected' });
    expect(rejected.map((d) => d.id)).toContain(row.id);
    expect(rejected.every((d) => d.status === 'rejected')).toBe(true);
    expect(rejected.find((d) => d.id === row.id)?.employeeName).toBe('Bob Example');
  });
});

describe('the review flow', () => {
  it('goes pending → approved → paid, and each step only once', async () => {
    const row = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_hr');
    await expect(markDeclarationPaid(db, row.id, 'user_hr')).rejects.toBeInstanceOf(HrConflictError);

    const approved = await reviewDeclaration(db, row.id, { decision: 'approved' }, 'user_hr');
    expect(approved.status).toBe('approved');
    expect(approved.reviewedBy).toBe('user_hr');
    await expect(reviewDeclaration(db, row.id, { decision: 'rejected' }, 'user_hr')).rejects.toBeInstanceOf(HrConflictError);

    const paid = await markDeclarationPaid(db, row.id, 'user_finance');
    expect(paid.status).toBe('paid');
    expect(paid.paidBy).toBe('user_finance');
    expect(paid.paidAt).toBeInstanceOf(Date);
    await expect(markDeclarationPaid(db, row.id, 'user_finance')).rejects.toBeInstanceOf(HrConflictError);
  });

  it('locks the amount once a decision is made', async () => {
    const row = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_hr');
    const edited = await updateDeclaration(db, row.id, { amount: 50 });
    expect(Number(edited.amount)).toBe(50);
    await reviewDeclaration(db, row.id, { decision: 'approved' }, 'user_hr');
    await expect(updateDeclaration(db, row.id, { amount: 500 })).rejects.toBeInstanceOf(HrConflictError);
  });
});

describe('what an employee may do', () => {
  it('withdraws their own pending declaration, but not an approved one', async () => {
    const pending = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_alice');
    expect((await cancelDeclaration(db, pending.id, ALICE)).status).toBe('cancelled');

    const approved = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_alice');
    await reviewDeclaration(db, approved.id, { decision: 'approved' }, 'user_hr');
    await expect(cancelDeclaration(db, approved.id, ALICE)).rejects.toBeInstanceOf(HrConflictError);
    // HR still can, as long as it has not been paid.
    expect((await cancelDeclaration(db, approved.id)).status).toBe('cancelled');
  });

  it("treats someone else's declaration as not found", async () => {
    const { bucket } = fakeBucket();
    const row = await createDeclaration(db, { employeeId: BOB, ...expense() }, 'user_bob');
    await expect(cancelDeclaration(db, row.id, ALICE)).rejects.toBeInstanceOf(HrNotFoundError);
    await expect(attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt(), ALICE)).rejects.toBeInstanceOf(
      HrNotFoundError,
    );
    await expect(loadDeclarationReceipt(db, bucket, WORKSPACE, row.id, ALICE)).rejects.toBeInstanceOf(HrNotFoundError);
  });

  it('sees only their own declarations, with open totals per currency', async () => {
    await db.delete(schema.hrDeclarations);
    await createDeclaration(db, { employeeId: ALICE, ...expense({ amount: 10 }) }, 'user_alice');
    await createDeclaration(db, { employeeId: ALICE, ...expense({ amount: 5.25 }) }, 'user_alice');
    const approved = await createDeclaration(db, { employeeId: ALICE, ...expense({ amount: 30 }) }, 'user_alice');
    await reviewDeclaration(db, approved.id, { decision: 'approved' }, 'user_hr');
    const usd = await createDeclaration(db, { employeeId: ALICE, ...expense({ amount: 7, currency: 'USD' }) }, 'user_alice');
    await reviewDeclaration(db, usd.id, { decision: 'rejected' }, 'user_hr');
    await createDeclaration(db, { employeeId: BOB, ...expense({ amount: 999 }) }, 'user_bob');

    const mine = await employeeDeclarations(db, ALICE);
    expect(mine.declarations).toHaveLength(4);
    expect(mine.open).toEqual([{ currency: 'EUR', pending: 15.25, approved: 30 }]);
  });
});

describe('receipts', () => {
  it('stores the file under the workspace and serves it back', async () => {
    const { bucket, objects } = fakeBucket();
    const row = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_alice');
    const withReceipt = await attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt('my ticket (1).pdf'), ALICE);

    expect(withReceipt.receiptFileKey).toMatch(new RegExp(`^workspaces/${WORKSPACE}/hr/declarations/${row.id}/`));
    expect(withReceipt.receiptFileName).toBe('my_ticket__1_.pdf');
    expect(toPublicDeclaration(withReceipt).hasReceipt).toBe(true);
    expect(objects.size).toBe(1);

    const loaded = await loadDeclarationReceipt(db, bucket, WORKSPACE, row.id, ALICE);
    expect(loaded.contentType).toBe('application/pdf');
    // Another workspace's request never resolves the key.
    await expect(loadDeclarationReceipt(db, bucket, 'ws_other', row.id)).rejects.toBeInstanceOf(HrNotFoundError);
  });

  it('replaces the previous file and removes it with the declaration', async () => {
    const { bucket, objects } = fakeBucket();
    const row = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_alice');
    const first = await attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt('a.png', 'image/png'));
    const second = await attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt('b.png', 'image/png'));
    expect(second.receiptFileKey).not.toBe(first.receiptFileKey);
    expect([...objects.keys()]).toEqual([second.receiptFileKey]);

    const deleted = await deleteDeclaration(db, row.id);
    expect(deleted.receiptFileKey).toBe(second.receiptFileKey);
    await expect(loadDeclarationReceipt(db, bucket, WORKSPACE, row.id)).rejects.toBeInstanceOf(HrNotFoundError);
  });

  it('refuses other file types, oversized files, and changes after the review', async () => {
    const { bucket, objects } = fakeBucket();
    const row = await createDeclaration(db, { employeeId: ALICE, ...expense() }, 'user_alice');
    await expect(
      attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt('page.html', 'text/html')),
    ).rejects.toBeInstanceOf(HrValidationError);
    await expect(
      attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt('big.pdf', 'application/pdf', 10 * 1024 * 1024 + 1)),
    ).rejects.toBeInstanceOf(HrValidationError);

    await reviewDeclaration(db, row.id, { decision: 'approved' }, 'user_hr');
    await expect(attachDeclarationReceipt(db, bucket, WORKSPACE, row.id, receipt())).rejects.toBeInstanceOf(HrConflictError);
    expect(objects.size).toBe(0);
  });
});
