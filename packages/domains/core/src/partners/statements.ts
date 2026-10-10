/**
 * Partner statements: what a partner owes for a calendar month (UTC).
 *
 * `buildStatement` prices every workspace the partner licensed during the
 * period from the licence history (day-prorated), the peak seat snapshot and
 * extra-credit grants, using the shared maths in
 * `@weldsuite/app-api-client/schemas/partners`. It reads only; `saveStatement`
 * persists a built statement. The portal shows the current month live with the
 * same function, so the preview and the invoice cannot disagree.
 */

import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  daysInPeriod,
  fromCents,
  licenceSegments,
  priceWorkspacePeriod,
  type LicenceChangePoint,
  type PartnerStatementView,
  type StatementLineAmounts,
} from '@weldsuite/app-api-client/schemas/partners';
import { getActiveContract, LicenceError } from './licences';
import { extraCreditCents, peakSeats } from './partners';
import type { PartnerDb } from './types';

const { workspaces, workspaceLicenceChanges, partnerStatements, partnerStatementLines } = masterSchema;

export interface BuiltStatementLine extends StatementLineAmounts {
  workspaceId: string;
  workspaceName: string;
}

export interface BuiltStatement {
  partnerId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  contract: Awaited<ReturnType<typeof getActiveContract>> & object;
  lines: BuiltStatementLine[];
  totalResale: number;
  totalDue: number;
  totalMargin: number;
}

/**
 * Price a partner's month. The contract is the one in force at the period's
 * start (a mid-month contract change applies from the next statement).
 */
export async function buildStatement(
  db: PartnerDb,
  partnerId: string,
  period: { start: Date; end: Date },
): Promise<BuiltStatement> {
  const contract = await getActiveContract(db, partnerId, period.start)
    ?? (await getActiveContract(db, partnerId, new Date(period.end.getTime() - 1)));
  if (!contract) throw new LicenceError('NO_CONTRACT', 'This partner has no contract for the period');

  // Every change up to the period end, for workspaces of this partner: the last
  // change before the period sets the licence in force on its first day.
  const changes = (await db
    .select({
      workspaceId: workspaceLicenceChanges.workspaceId,
      snapshot: workspaceLicenceChanges.snapshot,
      changedAt: workspaceLicenceChanges.changedAt,
    })
    .from(workspaceLicenceChanges)
    .where(and(eq(workspaceLicenceChanges.partnerId, partnerId), lt(workspaceLicenceChanges.changedAt, period.end)))
    .orderBy(asc(workspaceLicenceChanges.changedAt))) as Array<{
    workspaceId: string;
    snapshot: LicenceChangePoint['snapshot'];
    changedAt: Date;
  }>;

  const byWorkspace = new Map<string, LicenceChangePoint[]>();
  for (const c of changes) {
    const list = byWorkspace.get(c.workspaceId) ?? [];
    list.push({ changedAt: c.changedAt, snapshot: c.snapshot });
    byWorkspace.set(c.workspaceId, list);
  }

  const ids = [...byWorkspace.keys()];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = (await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(inArray(workspaces.id, ids))) as Array<{ id: string; name: string }>;
    for (const r of rows) names.set(r.id, r.name);
  }
  const [seats, extras] = await Promise.all([
    peakSeats(db, ids, period.start, period.end),
    extraCreditCents(db, partnerId, period.start, period.end),
  ]);

  const total = daysInPeriod(period.start, period.end);
  const lines: BuiltStatementLine[] = [];
  for (const [workspaceId, points] of byWorkspace) {
    const segments = licenceSegments(points, period.start, period.end);
    const extraCreditsCents = extras.get(workspaceId) ?? 0;
    if (segments.length === 0 && extraCreditsCents === 0) continue;
    const amounts = priceWorkspacePeriod({
      contract,
      segments,
      daysInPeriod: total,
      peakSeats: seats.get(workspaceId) ?? 0,
      extraCreditsCents,
    });
    lines.push({ workspaceId, workspaceName: names.get(workspaceId) ?? workspaceId, ...amounts });
  }
  lines.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));

  return {
    partnerId,
    periodStart: period.start,
    periodEnd: period.end,
    currency: contract.currency,
    contract,
    lines,
    totalResale: lines.reduce((s, l) => s + l.resale, 0),
    totalDue: lines.reduce((s, l) => s + l.due, 0),
    totalMargin: lines.reduce((s, l) => s + l.margin, 0),
  };
}

/**
 * Persist a built statement as `final` (or `draft`). Re-saving a period that is
 * still draft/final replaces its lines; an invoiced, paid or void statement is
 * never touched (returns it unchanged).
 */
export async function saveStatement(
  db: PartnerDb,
  built: BuiltStatement,
  status: 'draft' | 'final' = 'final',
): Promise<typeof partnerStatements.$inferSelect> {
  const [existing] = (await db
    .select()
    .from(partnerStatements)
    .where(and(eq(partnerStatements.partnerId, built.partnerId), eq(partnerStatements.periodStart, built.periodStart)))
    .limit(1)) as Array<typeof partnerStatements.$inferSelect>;
  if (existing && !['draft', 'final'].includes(existing.status)) return existing;

  const now = new Date();
  const values = {
    periodEnd: built.periodEnd,
    currency: built.currency,
    status,
    totalResale: fromCents(built.totalResale),
    totalDue: fromCents(built.totalDue),
    totalMargin: fromCents(built.totalMargin),
    contractSnapshot: { ...built.contract } as Record<string, unknown>,
    finalizedAt: status === 'final' ? now : null,
    updatedAt: now,
  };
  let statement: typeof partnerStatements.$inferSelect;
  if (existing) {
    [statement] = await db.update(partnerStatements).set(values).where(eq(partnerStatements.id, existing.id)).returning();
    await db.delete(partnerStatementLines).where(eq(partnerStatementLines.statementId, existing.id));
  } else {
    [statement] = await db
      .insert(partnerStatements)
      .values({ id: generateId('pst'), partnerId: built.partnerId, periodStart: built.periodStart, ...values })
      .returning();
  }
  if (built.lines.length > 0) {
    await db.insert(partnerStatementLines).values(
      built.lines.map((l) => ({
        id: generateId('psl'),
        statementId: statement.id,
        workspaceId: l.workspaceId,
        workspaceName: l.workspaceName,
        daysActive: l.daysActive,
        daysInPeriod: l.daysInPeriod,
        seatsBilled: l.seatsBilled,
        resale: fromCents(l.resale),
        shareAmount: fromCents(l.share),
        floorAmount: fromCents(l.floor),
        creditFloorAmount: fromCents(l.creditFloor),
        extraCreditsAmount: fromCents(l.extraCredits),
        due: fromCents(l.due),
        margin: fromCents(l.margin),
        breakdown: l.breakdown as unknown as Record<string, unknown>[],
      })),
    );
  }
  return statement;
}

/** A built (unsaved) statement as the portal/admin view. */
export function builtStatementView(built: BuiltStatement): PartnerStatementView {
  return {
    id: null,
    periodStart: built.periodStart.toISOString(),
    periodEnd: built.periodEnd.toISOString(),
    currency: built.currency,
    status: 'preview',
    totalResale: fromCents(built.totalResale),
    totalDue: fromCents(built.totalDue),
    totalMargin: fromCents(built.totalMargin),
    stripeInvoiceUrl: null,
    stripeInvoicePdf: null,
    dueAt: null,
    paidAt: null,
    lines: built.lines.map((l) => ({
      workspaceId: l.workspaceId,
      workspaceName: l.workspaceName,
      daysActive: l.daysActive,
      daysInPeriod: l.daysInPeriod,
      seatsBilled: l.seatsBilled,
      resale: fromCents(l.resale),
      shareAmount: fromCents(l.share),
      floorAmount: fromCents(l.floor),
      creditFloorAmount: fromCents(l.creditFloor),
      extraCreditsAmount: fromCents(l.extraCredits),
      due: fromCents(l.due),
      margin: fromCents(l.margin),
    })),
  };
}

/** A saved statement with its lines, as the portal/admin view. */
export async function loadStatementView(db: PartnerDb, statementId: string): Promise<PartnerStatementView | null> {
  const [s] = (await db
    .select()
    .from(partnerStatements)
    .where(eq(partnerStatements.id, statementId))
    .limit(1)) as Array<typeof partnerStatements.$inferSelect>;
  if (!s) return null;
  const lines = (await db
    .select()
    .from(partnerStatementLines)
    .where(eq(partnerStatementLines.statementId, s.id))
    .orderBy(asc(partnerStatementLines.workspaceName))) as Array<typeof partnerStatementLines.$inferSelect>;
  return {
    id: s.id,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    currency: s.currency,
    status: s.status,
    totalResale: s.totalResale,
    totalDue: s.totalDue,
    totalMargin: s.totalMargin,
    stripeInvoiceUrl: s.stripeInvoiceUrl,
    stripeInvoicePdf: s.stripeInvoicePdf,
    dueAt: s.dueAt?.toISOString() ?? null,
    paidAt: s.paidAt?.toISOString() ?? null,
    lines: lines.map((l) => ({
      workspaceId: l.workspaceId,
      workspaceName: l.workspaceName,
      daysActive: l.daysActive,
      daysInPeriod: l.daysInPeriod,
      seatsBilled: l.seatsBilled,
      resale: l.resale,
      shareAmount: l.shareAmount,
      floorAmount: l.floorAmount,
      creditFloorAmount: l.creditFloorAmount,
      extraCreditsAmount: l.extraCreditsAmount,
      due: l.due,
      margin: l.margin,
    })),
  };
}

/** Statements of a partner, newest first, without lines. */
export async function listStatements(db: PartnerDb, partnerId: string, sinceDate?: Date) {
  const where = sinceDate
    ? and(eq(partnerStatements.partnerId, partnerId), gte(partnerStatements.periodStart, sinceDate))
    : eq(partnerStatements.partnerId, partnerId);
  const rows = (await db.select().from(partnerStatements).where(where)) as Array<typeof partnerStatements.$inferSelect>;
  return rows.sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime());
}
