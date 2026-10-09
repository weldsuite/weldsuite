/**
 * Declarations — expense claims.
 *
 * An employee (or HR on their behalf) files an expense; HR approves or rejects
 * it, then marks an approved one as paid once it has been reimbursed:
 *
 *   pending → approved → paid
 *           ↘ rejected
 *   pending / approved → cancelled
 *
 * The amount and the receipt can only change while the declaration is still
 * pending, so what was approved is what gets paid.
 *
 * The receipt is one private R2 object per declaration. Its key lives under
 * the workspace prefix and is never handed to a client; the routes stream it
 * after their own access check.
 */

import { and, desc, eq, gte, inArray, isNull, lte, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  HR_DECLARATION_RECEIPT_MAX_BYTES,
  HR_DECLARATION_RECEIPT_TYPES,
} from '@weldsuite/app-api-client/schemas/weldhr';
import { displayNameOf, requireEmployee } from './employees';
import { HrConflictError, HrNotFoundError, HrValidationError, addDays, memberNames, todayIso } from './shared';

const dcl = schema.hrDeclarations;
const emp = schema.hrEmployees;

/** Statuses that still have money outstanding. */
const OPEN_STATUSES = ['pending', 'approved'] as const;

type DeclarationRow = typeof dcl.$inferSelect;

export interface DeclarationFields {
  expenseDate: string;
  category: string;
  description: string;
  amount: number;
  currency?: string;
}

/**
 * What a client gets: the amount as a number, and `hasReceipt` plus the file's
 * name and type instead of the storage key.
 */
export function toPublicDeclaration(row: DeclarationRow) {
  const { receiptFileKey, amount, ...rest } = row;
  return { ...rest, amount: Number(amount), hasReceipt: Boolean(receiptFileKey) };
}

export type PublicDeclaration = ReturnType<typeof toPublicDeclaration>;

/**
 * Dates are compared in UTC, and a client east of it is already on tomorrow's
 * date for part of the day, so "not in the future" allows one day of slack.
 */
function assertExpenseDate(expenseDate: string) {
  if (expenseDate > addDays(todayIso(), 1)) throw new HrValidationError('The expense date cannot be in the future');
}

/** A declaration, optionally only when it belongs to `onlyEmployeeId` (self-service: anyone else's is a 404). */
export async function requireDeclaration(db: Database, id: string, onlyEmployeeId?: string) {
  const [row] = await db.select().from(dcl).where(eq(dcl.id, id)).limit(1);
  if (!row || (onlyEmployeeId && row.employeeId !== onlyEmployeeId)) throw new HrNotFoundError('Declaration', id);
  return row;
}

export async function listDeclarations(
  db: Database,
  filters: { employeeId?: string; status?: string; category?: string; from?: string; to?: string } = {},
) {
  const conditions: SQL[] = [isNull(emp.deletedAt)];
  if (filters.employeeId) conditions.push(eq(dcl.employeeId, filters.employeeId));
  if (filters.status) conditions.push(inArray(dcl.status, filters.status.split(',')));
  if (filters.category) conditions.push(inArray(dcl.category, filters.category.split(',')));
  if (filters.from) conditions.push(gte(dcl.expenseDate, filters.from));
  if (filters.to) conditions.push(lte(dcl.expenseDate, filters.to));
  const rows = await db
    .select({
      declaration: dcl,
      employeeFirstName: emp.firstName,
      employeeLastName: emp.lastName,
      employeePreferredName: emp.preferredName,
    })
    .from(dcl)
    .innerJoin(emp, eq(emp.id, dcl.employeeId))
    .where(and(...conditions))
    .orderBy(desc(dcl.expenseDate), desc(dcl.createdAt))
    .limit(1000);
  const reviewers = await memberNames(db, rows.map((r) => r.declaration.reviewedBy));
  return rows.map((r) => ({
    ...toPublicDeclaration(r.declaration),
    employeeName: displayNameOf({
      firstName: r.employeeFirstName,
      lastName: r.employeeLastName,
      preferredName: r.employeePreferredName,
    }),
    reviewedByName: r.declaration.reviewedBy ? reviewers.get(r.declaration.reviewedBy) ?? null : null,
  }));
}

export async function createDeclaration(
  db: Database,
  input: DeclarationFields & { employeeId: string },
  submittedBy: string,
) {
  assertExpenseDate(input.expenseDate);
  await requireEmployee(db, input.employeeId);
  const [row] = await db
    .insert(dcl)
    .values({
      id: generateId('hrdcl'),
      employeeId: input.employeeId,
      expenseDate: input.expenseDate,
      category: input.category,
      description: input.description,
      amount: input.amount.toFixed(2),
      currency: input.currency ?? 'EUR',
      status: 'pending',
      submittedBy,
    })
    .returning();
  return row!;
}

export async function updateDeclaration(db: Database, id: string, input: Partial<DeclarationFields>) {
  const existing = await requireDeclaration(db, id);
  if (existing.status !== 'pending') {
    throw new HrConflictError(`This declaration is already ${existing.status} and can no longer be changed`);
  }
  if (input.expenseDate) assertExpenseDate(input.expenseDate);
  const [row] = await db
    .update(dcl)
    .set({
      ...(input.expenseDate !== undefined && { expenseDate: input.expenseDate }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.amount !== undefined && { amount: input.amount.toFixed(2) }),
      ...(input.currency !== undefined && { currency: input.currency }),
      updatedAt: new Date(),
    })
    .where(eq(dcl.id, id))
    .returning();
  return row!;
}

export async function reviewDeclaration(
  db: Database,
  id: string,
  input: { decision: 'approved' | 'rejected'; note?: string | null },
  reviewedBy: string,
) {
  const existing = await requireDeclaration(db, id);
  if (existing.status !== 'pending') {
    throw new HrConflictError(`This declaration is already ${existing.status}`);
  }
  const now = new Date();
  const [row] = await db
    .update(dcl)
    .set({ status: input.decision, reviewNote: input.note ?? null, reviewedBy, reviewedAt: now, updatedAt: now })
    .where(eq(dcl.id, id))
    .returning();
  return row!;
}

export async function markDeclarationPaid(db: Database, id: string, paidBy: string) {
  const existing = await requireDeclaration(db, id);
  if (existing.status !== 'approved') {
    throw new HrConflictError('Only an approved declaration can be marked as paid');
  }
  const now = new Date();
  const [row] = await db
    .update(dcl)
    .set({ status: 'paid', paidBy, paidAt: now, updatedAt: now })
    .where(eq(dcl.id, id))
    .returning();
  return row!;
}

/**
 * Withdraw a declaration. An employee (`onlyEmployeeId`) can only withdraw
 * their own, and only while it is pending; HR can also cancel an approved one
 * that has not been paid yet.
 */
export async function cancelDeclaration(db: Database, id: string, onlyEmployeeId?: string) {
  const existing = await requireDeclaration(db, id, onlyEmployeeId);
  const cancellable = onlyEmployeeId ? existing.status === 'pending' : existing.status === 'pending' || existing.status === 'approved';
  if (!cancellable) {
    throw new HrConflictError(`This declaration is already ${existing.status}`);
  }
  const [row] = await db
    .update(dcl)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(dcl.id, id))
    .returning();
  return row!;
}

/** Deletes the row and returns it, so the caller can remove the receipt object. */
export async function deleteDeclaration(db: Database, id: string) {
  const existing = await requireDeclaration(db, id);
  await db.delete(dcl).where(eq(dcl.id, id));
  return existing;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120);
  return cleaned || 'receipt';
}

/**
 * Store (or replace) the receipt of a pending declaration. The object goes in
 * first and the row is pointed at it second, so a failed write never leaves a
 * declaration pointing at nothing; the replaced object is removed last.
 */
export async function attachDeclarationReceipt(
  db: Database,
  bucket: R2Bucket,
  workspaceId: string,
  id: string,
  file: File,
  onlyEmployeeId?: string,
) {
  const existing = await requireDeclaration(db, id, onlyEmployeeId);
  if (existing.status !== 'pending') {
    throw new HrConflictError(`This declaration is already ${existing.status} and its receipt can no longer be changed`);
  }
  if (!(HR_DECLARATION_RECEIPT_TYPES as readonly string[]).includes(file.type)) {
    throw new HrValidationError('A receipt must be a JPEG, PNG or WebP image, or a PDF');
  }
  if (file.size === 0) throw new HrValidationError('The receipt file is empty');
  if (file.size > HR_DECLARATION_RECEIPT_MAX_BYTES) {
    throw new HrValidationError('A receipt can be at most 10 MB');
  }

  const fileName = safeFileName(file.name);
  // The random segment keeps the key unguessable and makes a replacement a new object.
  const key = `workspaces/${workspaceId}/hr/declarations/${id}/${crypto.randomUUID().replace(/-/g, '')}/${fileName}`;
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  const [row] = await db
    .update(dcl)
    .set({
      receiptFileKey: key,
      receiptFileName: fileName,
      receiptContentType: file.type,
      receiptSize: file.size,
      updatedAt: new Date(),
    })
    .where(eq(dcl.id, id))
    .returning();
  if (existing.receiptFileKey) await bucket.delete(existing.receiptFileKey);
  return row!;
}

/** The stored receipt, or a 404 when there is none (or the object is gone). */
export async function loadDeclarationReceipt(
  db: Database,
  bucket: R2Bucket,
  workspaceId: string,
  id: string,
  onlyEmployeeId?: string,
) {
  const row = await requireDeclaration(db, id, onlyEmployeeId);
  const key = row.receiptFileKey;
  // The prefix check is belt and braces: keys are only ever written by attachDeclarationReceipt.
  if (!key || !key.startsWith(`workspaces/${workspaceId}/hr/declarations/`)) {
    throw new HrNotFoundError('Receipt', id);
  }
  const object = await bucket.get(key);
  if (!object) throw new HrNotFoundError('Receipt', id);
  return {
    object,
    fileName: row.receiptFileName ?? 'receipt',
    contentType: row.receiptContentType ?? 'application/octet-stream',
  };
}

/** The multipart `file` part of a receipt upload. */
export function receiptFileFrom(body: Record<string, unknown>): File {
  const file = body.file;
  if (!(file instanceof File)) throw new HrValidationError('Send the receipt as a multipart "file" field');
  return file;
}

/**
 * Stream a receipt. Only images and PDFs are ever stored, and `nosniff` keeps
 * the browser from treating one as anything else.
 */
export function receiptResponse(receipt: Awaited<ReturnType<typeof loadDeclarationReceipt>>): Response {
  return new Response(receipt.object.body, {
    status: 200,
    headers: {
      'Content-Type': receipt.contentType,
      'Content-Disposition': `inline; filename="${receipt.fileName.replaceAll('"', '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------------------------------------------------------------------------
// Self-service (My HR and the workforce portal)
// ---------------------------------------------------------------------------

/** The employee's own declarations, with what is still awaiting a decision or a payout. */
export async function employeeDeclarations(db: Database, employeeId: string) {
  const rows = await db
    .select()
    .from(dcl)
    .where(eq(dcl.employeeId, employeeId))
    .orderBy(desc(dcl.expenseDate), desc(dcl.createdAt))
    .limit(500);
  const declarations = rows.map((row) => {
    const d = toPublicDeclaration(row);
    return {
      id: d.id,
      expenseDate: d.expenseDate,
      category: d.category,
      description: d.description,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      hasReceipt: d.hasReceipt,
      receiptFileName: d.receiptFileName,
      reviewNote: d.reviewNote,
      reviewedAt: d.reviewedAt,
      paidAt: d.paidAt,
      createdAt: d.createdAt,
    };
  });
  // Totals per currency: amounts in different currencies are never added together.
  const totals = new Map<string, { currency: string; pending: number; approved: number }>();
  for (const d of declarations) {
    const open = OPEN_STATUSES.find((status) => status === d.status);
    if (!open) continue;
    const entry = totals.get(d.currency) ?? { currency: d.currency, pending: 0, approved: 0 };
    entry[open] = Math.round((entry[open] + d.amount) * 100) / 100;
    totals.set(d.currency, entry);
  }
  return { declarations, open: [...totals.values()] };
}
