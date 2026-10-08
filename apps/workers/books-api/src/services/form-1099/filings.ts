/**
 * 1099 filings: one filing per form type and tax year of an entity, one line
 * per recipient (docs/plans/weldbooks-us.md section 8).
 *
 *   draft      lines follow the yearly computation; manual adjustments (with a
 *              reason), manual exclusions and state fields are kept on refresh
 *   reviewed   someone looked at it
 *   generated  recipient name, address and TIN type are snapshotted into each
 *              line and the TIN is copied in encrypted (never shown again)
 *   filed      the IRIS upload is done; the lines turn `filed`
 *   corrected  a filed recipient was corrected: a new line (`is_corrected`,
 *              `correction_of_line_id`) waits to be filed; the original stays
 *
 * Line statuses: included | excluded | needs_tin | needs_address, plus `filed`
 * once the filing was marked filed (an included line that went out).
 * Exclusions the computation made itself start with `AUTO_EXCLUDED_PREFIX` and
 * come back when the amounts change; any other reason is a manual exclusion
 * that survives a refresh.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { omitSensitive, type WithoutSensitive } from '@weldsuite/db/lib/sensitive-columns';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import {
  form1099Box,
  form1099StateRule,
  stateNeedsDirectFiling,
  withholdingBoxFor,
  type Form1099Type,
} from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import type { Compute1099Adjustment, Form1099VendorResult } from '@weldsuite/books-domain/us-compliance/form-1099-compute';
import { readSensitive, requireKeyring, type PartyW9 } from '../vendor-tax-data';
import { Form1099Error } from './errors';
import type { PartyRow } from './load';
import { boxesOfForm, compute1099ForEntity, formOfBox } from './summary';

export type FilingRow = typeof schema.form1099Filings.$inferSelect;
export type LineRow = typeof schema.form1099FilingLines.$inferSelect;
type LineInsert = typeof schema.form1099FilingLines.$inferInsert;
type LineAdjustment = NonNullable<LineRow['adjustments']>[number];

export const AUTO_EXCLUDED_PREFIX = 'Not reportable: ';

const EDITABLE: readonly string[] = ['draft', 'reviewed'];
const REPORTABLE_STATUSES = ['included', 'needs_tin', 'needs_address'] as const;

const cents = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface FilingLineView extends WithoutSensitive<'form_1099_filing_lines', LineRow> {
  hasTin: boolean;
  partyName: string | null;
  /** A later correction replaced this line. */
  superseded: boolean;
  /** A correction that has not been filed yet. */
  pendingCorrection: boolean;
  stateHint: {
    state: string;
    cfsfCode: string | null;
    direct: string;
    verified: boolean;
    note: string | null;
    needsDirectFiling: boolean;
  } | null;
}

export function isManualExclusion(line: Pick<LineRow, 'status' | 'excludedReason'>): boolean {
  return line.status === 'excluded' && Boolean(line.excludedReason) && !line.excludedReason!.startsWith(AUTO_EXCLUDED_PREFIX);
}

function toLineView(line: LineRow, names: Map<string, string>, superseded: Set<string>): FilingLineView {
  const rest = omitSensitive('form_1099_filing_lines', line);
  const state = line.recipient?.address?.state;
  const rule = state ? form1099StateRule(state) : null;
  return {
    ...rest,
    hasTin: Boolean(line.recipientTinEncrypted),
    partyName: names.get(line.partyId) ?? line.recipient?.name ?? null,
    superseded: superseded.has(line.id),
    pendingCorrection: line.isCorrected && line.status === 'included',
    stateHint: state && rule
      ? {
          state: state.toUpperCase(),
          cfsfCode: rule.cfsfCode,
          direct: rule.direct,
          verified: rule.verified,
          note: rule.note ?? null,
          needsDirectFiling: stateNeedsDirectFiling(state, {
            stateWithheld: Number(line.stateWithheld ?? 0) > 0,
            stateSource: true,
          }),
        }
      : null,
  };
}

export interface FilingView extends FilingRow {
  lineCount: number;
  totals: { amount: number; withheld: number };
  statusCounts: Record<string, number>;
}

function filingTotals(filing: FilingRow, lines: LineRow[]): FilingView {
  const superseded = new Set(lines.map((l) => l.correctionOfLineId).filter((id): id is string => Boolean(id)));
  const statusCounts: Record<string, number> = {};
  let amount = 0;
  let withheld = 0;
  for (const line of lines) {
    statusCounts[line.status] = (statusCounts[line.status] ?? 0) + 1;
    if (superseded.has(line.id) || !['included', 'filed', 'needs_tin', 'needs_address'].includes(line.status)) continue;
    for (const [code, value] of Object.entries(line.boxes)) {
      const def = form1099Box(code);
      if (!def || def.kind !== 'amount') continue;
      if (code === withholdingBoxFor(filing.formType as Form1099Type)) withheld += value;
      else amount += value;
    }
  }
  return { ...filing, lineCount: lines.length, totals: { amount: cents(amount), withheld: cents(withheld) }, statusCounts };
}

async function partyNames(db: Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.parties.id, displayName: schema.parties.displayName })
    .from(schema.parties)
    .where(inArray(schema.parties.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.displayName ?? '']));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadFiling(db: Database, entityId: string, filingId: string): Promise<FilingRow> {
  const [filing] = await db
    .select()
    .from(schema.form1099Filings)
    .where(
      and(
        eq(schema.form1099Filings.id, filingId),
        eq(schema.form1099Filings.entityId, entityId),
        isNull(schema.form1099Filings.deletedAt),
      ),
    )
    .limit(1);
  if (!filing) throw new Form1099Error('not_found', `1099 filing ${filingId} not found`);
  return filing;
}

export async function loadLines(db: Database, filingId: string): Promise<LineRow[]> {
  return db
    .select()
    .from(schema.form1099FilingLines)
    .where(eq(schema.form1099FilingLines.filingId, filingId))
    .orderBy(schema.form1099FilingLines.createdAt, schema.form1099FilingLines.id);
}

async function loadLine(db: Database, filing: FilingRow, lineId: string): Promise<LineRow> {
  const [line] = await db
    .select()
    .from(schema.form1099FilingLines)
    .where(and(eq(schema.form1099FilingLines.id, lineId), eq(schema.form1099FilingLines.filingId, filing.id)))
    .limit(1);
  if (!line) throw new Form1099Error('not_found', `Filing line ${lineId} not found`);
  return line;
}

export async function loadFilingDetail(db: Database, entityId: string, filingId: string) {
  const filing = await loadFiling(db, entityId, filingId);
  const lines = await loadLines(db, filing.id);
  const names = await partyNames(db, lines.map((l) => l.partyId));
  const superseded = new Set(lines.map((l) => l.correctionOfLineId).filter((id): id is string => Boolean(id)));
  return { filing: filingTotals(filing, lines), lines: lines.map((l) => toLineView(l, names, superseded)) };
}

export async function listFilings(
  db: Database,
  entityId: string,
  filter: { taxYear?: number; formType?: string; status?: string },
): Promise<FilingView[]> {
  const filings = await db
    .select()
    .from(schema.form1099Filings)
    .where(
      and(
        eq(schema.form1099Filings.entityId, entityId),
        isNull(schema.form1099Filings.deletedAt),
        filter.taxYear ? eq(schema.form1099Filings.taxYear, filter.taxYear) : undefined,
        filter.formType ? eq(schema.form1099Filings.formType, filter.formType) : undefined,
        filter.status ? eq(schema.form1099Filings.status, filter.status) : undefined,
      ),
    )
    .orderBy(schema.form1099Filings.taxYear, schema.form1099Filings.formType);
  if (filings.length === 0) return [];
  const lines = await db
    .select()
    .from(schema.form1099FilingLines)
    .where(inArray(schema.form1099FilingLines.filingId, filings.map((f) => f.id)));
  return filings.map((filing) =>
    filingTotals(filing, lines.filter((l) => l.filingId === filing.id)),
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** The recipient as it would print today: W-9 name, address and the TIN's type and last four. */
export function snapshotRecipient(party: PartyRow): NonNullable<LineRow['recipient']> {
  const w9 = party.w9 as PartyW9 | null;
  const name = w9?.legalName?.trim() || party.displayName?.trim() || 'Unnamed vendor';
  const business = w9?.businessName?.trim();
  const address = normalizePostalAddress(party.billingAddress);
  return {
    name,
    ...(business && business.toLowerCase() !== name.toLowerCase() ? { businessName: business } : {}),
    ...(address ? { address: { ...address } } : {}),
    ...(party.tinType ? { tinType: party.tinType } : {}),
    ...(party.tinLast4 ? { tinLast4: party.tinLast4 } : {}),
  };
}

function lineFields(vendor: Form1099VendorResult, form: Form1099Type, party: PartyRow) {
  const boxes = boxesOfForm(vendor.boxes, form);
  return {
    boxes,
    federalWithheld: (boxes[withholdingBoxFor(form)] ?? 0).toFixed(2),
    recipient: snapshotRecipient(party),
    status: vendor.status,
  };
}

function hasAmounts(boxes: Record<string, number>): boolean {
  return Object.values(boxes).some((value) => value > 0);
}

function isReportable(vendor: Form1099VendorResult, form: Form1099Type): boolean {
  return (REPORTABLE_STATUSES as readonly string[]).includes(vendor.status) && hasAmounts(boxesOfForm(vendor.boxes, form));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateFilingInput {
  entityId: string;
  taxYear: number;
  formType: Form1099Type;
  userId: string | null;
}

export async function createFiling(db: Database, input: CreateFilingInput) {
  const existing = await db
    .select({ id: schema.form1099Filings.id })
    .from(schema.form1099Filings)
    .where(
      and(
        eq(schema.form1099Filings.entityId, input.entityId),
        eq(schema.form1099Filings.taxYear, input.taxYear),
        eq(schema.form1099Filings.formType, input.formType),
        isNull(schema.form1099Filings.deletedAt),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw new Form1099Error(
      'conflict',
      `There is already a 1099-${input.formType.toUpperCase()} filing for ${input.taxYear}. Open it, or delete it while it is a draft.`,
      { filingId: existing[0].id },
    );
  }

  const { loaded, result } = await compute1099ForEntity(db, input.entityId, input.taxYear);
  const now = new Date();
  const filingId = generateId('f99');
  const lines: LineInsert[] = [];
  for (const vendor of result.vendors) {
    const party = loaded.parties.get(vendor.partyId);
    if (!party || !isReportable(vendor, input.formType)) continue;
    lines.push({
      id: generateId('f9l'),
      entityId: input.entityId,
      filingId,
      partyId: vendor.partyId,
      ...lineFields(vendor, input.formType, party),
      createdAt: now,
      updatedAt: now,
    });
  }

  await atomically(db, (h) => [
    h.insert(schema.form1099Filings).values({
      id: filingId,
      entityId: input.entityId,
      taxYear: input.taxYear,
      formType: input.formType,
      status: 'draft',
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    }),
    ...(lines.length > 0 ? [h.insert(schema.form1099FilingLines).values(lines)] : []),
  ]);
  return { filingId, lineCount: lines.length, warnings: result.warnings };
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

function adjustmentsOf(lines: LineRow[], form: Form1099Type): Compute1099Adjustment[] {
  return lines.flatMap((line) =>
    (line.adjustments ?? [])
      .filter((a) => formOfBox(a.box) === form && form1099Box(a.box)?.kind === 'amount')
      .map((a) => ({ partyId: line.partyId, box: a.box, amount: a.amount, reason: a.reason, by: a.by })),
  );
}

/** What each editable line becomes after recomputing from the books; `added` are vendors with no line yet. */
async function recomputeLines(
  db: Database,
  filing: FilingRow,
  existingLines: LineRow[],
  options: { onlyLineIds?: string[] },
) {
  const form = filing.formType as Form1099Type;
  const editable = existingLines.filter((l) => !l.isCorrected && l.status !== 'filed');
  const targets = options.onlyLineIds ? editable.filter((l) => options.onlyLineIds!.includes(l.id)) : editable;

  const { loaded, result } = await compute1099ForEntity(db, filing.entityId, filing.taxYear, {
    partyIds: options.onlyLineIds ? targets.map((l) => l.partyId) : undefined,
    adjustments: adjustmentsOf(targets, form),
  });
  const byParty = new Map(result.vendors.map((v) => [v.partyId, v]));

  const updates: Array<{ id: string; set: Partial<LineInsert> }> = [];
  for (const line of targets) {
    const party = loaded.parties.get(line.partyId);
    const vendor = byParty.get(line.partyId);
    if (!party) continue;
    const manual = isManualExclusion(line);
    if (vendor && isReportable(vendor, form)) {
      const fields = lineFields(vendor, form, party);
      updates.push({
        id: line.id,
        set: {
          ...fields,
          status: manual ? 'excluded' : fields.status,
          excludedReason: manual ? line.excludedReason : null,
        },
      });
    } else {
      const why = vendor?.reasons[0] ?? 'There are no payments to report in the year.';
      updates.push({
        id: line.id,
        set: {
          boxes: {},
          federalWithheld: '0.00',
          recipient: snapshotRecipient(party),
          status: 'excluded',
          excludedReason: manual ? line.excludedReason : `${AUTO_EXCLUDED_PREFIX}${why}`.slice(0, 255),
        },
      });
    }
  }

  const added: LineInsert[] = [];
  if (!options.onlyLineIds) {
    const have = new Set(existingLines.filter((l) => !l.isCorrected).map((l) => l.partyId));
    const now = new Date();
    for (const vendor of result.vendors) {
      const party = loaded.parties.get(vendor.partyId);
      if (!party || have.has(vendor.partyId) || !isReportable(vendor, form)) continue;
      added.push({
        id: generateId('f9l'),
        entityId: filing.entityId,
        filingId: filing.id,
        partyId: vendor.partyId,
        ...lineFields(vendor, form, party),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return { updates, added, warnings: result.warnings };
}

function assertEditable(filing: FilingRow) {
  if (!EDITABLE.includes(filing.status)) {
    throw new Form1099Error(
      'conflict',
      `The filing is ${filing.status}. Only a draft or reviewed filing can be changed; after filing, correct a recipient instead.`,
    );
  }
}

export async function refreshFiling(db: Database, entityId: string, filingId: string) {
  const filing = await loadFiling(db, entityId, filingId);
  assertEditable(filing);
  const lines = await loadLines(db, filing.id);
  const { updates, added, warnings } = await recomputeLines(db, filing, lines, {});
  const now = new Date();
  await atomically(db, (h) => [
    ...updates.map((u) =>
      h.update(schema.form1099FilingLines).set({ ...u.set, updatedAt: now }).where(eq(schema.form1099FilingLines.id, u.id)),
    ),
    ...(added.length > 0 ? [h.insert(schema.form1099FilingLines).values(added)] : []),
    h.update(schema.form1099Filings).set({ status: 'draft', updatedAt: now }).where(eq(schema.form1099Filings.id, filing.id)),
  ]);
  return { warnings, updated: updates.length, added: added.length };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface LinePatch {
  /** Replaces the line's manual adjustments. Each one adds to (or, negative, takes from) a box. */
  adjustments?: Array<{ box: string; amount: number; reason: string }>;
  status?: 'included' | 'excluded';
  excludedReason?: string | null;
  stateCode?: string | null;
  stateIdNumber?: string | null;
  stateIncome?: number | null;
  stateWithheld?: number | null;
  /** Only for a correction that has not been filed yet. */
  boxes?: Record<string, number>;
}

function validateBoxes(boxes: Record<string, number>, form: Form1099Type) {
  for (const [code, value] of Object.entries(boxes)) {
    const def = form1099Box(code);
    if (!def || def.kind !== 'amount' || def.form !== form) {
      throw new Form1099Error('bad_request', `${code} is not an amount box of form 1099-${form.toUpperCase()}`);
    }
    if (!Number.isFinite(value) || value < 0) throw new Form1099Error('bad_request', `Box ${code} must be zero or more`);
  }
}

function stampAdjustments(
  incoming: NonNullable<LinePatch['adjustments']>,
  existing: LineAdjustment[],
  form: Form1099Type,
  userId: string | null,
): LineAdjustment[] {
  const now = new Date().toISOString();
  return incoming.map((adjustment) => {
    const def = form1099Box(adjustment.box);
    if (!def || def.kind !== 'amount' || def.form !== form) {
      throw new Form1099Error('bad_request', `${adjustment.box} is not an amount box of form 1099-${form.toUpperCase()}`);
    }
    if (!adjustment.reason.trim()) throw new Form1099Error('bad_request', 'An adjustment needs a reason');
    if (!Number.isFinite(adjustment.amount) || adjustment.amount === 0) {
      throw new Form1099Error('bad_request', 'An adjustment needs a non-zero amount');
    }
    const same = existing.find(
      (e) => e.box === adjustment.box && e.amount === adjustment.amount && e.reason === adjustment.reason,
    );
    return same ?? { box: adjustment.box, amount: adjustment.amount, reason: adjustment.reason.trim(), by: userId ?? undefined, at: now };
  });
}

export async function updateLine(
  db: Database,
  entityId: string,
  filingId: string,
  lineId: string,
  patch: LinePatch,
  userId: string | null,
) {
  const filing = await loadFiling(db, entityId, filingId);
  const line = await loadLine(db, filing, lineId);
  const form = filing.formType as Form1099Type;
  const set: Partial<LineInsert> = {};

  const pendingCorrection = filing.status === 'corrected' && line.isCorrected && line.status === 'included';
  if (!EDITABLE.includes(filing.status) && !pendingCorrection) {
    throw new Form1099Error(
      'conflict',
      `The filing is ${filing.status}. Only a draft or reviewed filing, or a correction that has not been filed, can be changed.`,
    );
  }

  if (patch.stateCode !== undefined) set.stateCode = patch.stateCode ? patch.stateCode.toUpperCase() : null;
  if (patch.stateIdNumber !== undefined) set.stateIdNumber = patch.stateIdNumber;
  if (patch.stateIncome !== undefined) set.stateIncome = patch.stateIncome === null ? null : patch.stateIncome.toFixed(2);
  if (patch.stateWithheld !== undefined) set.stateWithheld = patch.stateWithheld === null ? null : patch.stateWithheld.toFixed(2);

  if (pendingCorrection) {
    if (patch.adjustments !== undefined) {
      throw new Form1099Error('bad_request', 'Set the boxes of a correction directly with `boxes`');
    }
    if (patch.boxes) {
      validateBoxes(patch.boxes, form);
      set.boxes = patch.boxes;
      set.federalWithheld = (patch.boxes[withholdingBoxFor(form)] ?? 0).toFixed(2);
    }
    if (patch.status === 'excluded') {
      if (!patch.excludedReason?.trim()) throw new Form1099Error('bad_request', 'Say why the correction is withdrawn');
      set.status = 'excluded';
      set.excludedReason = patch.excludedReason.trim();
    }
  } else {
    if (patch.boxes) throw new Form1099Error('bad_request', '`boxes` can only be set on a correction; use `adjustments`');
    let manualExclusion = isManualExclusion(line);
    let reason = line.excludedReason;
    if (patch.status === 'excluded') {
      if (!patch.excludedReason?.trim()) throw new Form1099Error('bad_request', 'Say why the recipient is excluded');
      manualExclusion = true;
      reason = patch.excludedReason.trim().slice(0, 255);
    } else if (patch.status === 'included') {
      manualExclusion = false;
      reason = null;
    }
    const adjustmentsChanged = patch.adjustments !== undefined;
    if (adjustmentsChanged) set.adjustments = stampAdjustments(patch.adjustments!, line.adjustments ?? [], form, userId);

    if (adjustmentsChanged || patch.status !== undefined) {
      // Recompute this recipient from the books with the new adjustments and exclusion.
      const working: LineRow = {
        ...line,
        adjustments: (set.adjustments as LineAdjustment[] | undefined) ?? line.adjustments,
        status: manualExclusion ? 'excluded' : 'included',
        excludedReason: manualExclusion ? reason : null,
      };
      const { updates } = await recomputeLines(db, filing, [working], { onlyLineIds: [line.id] });
      const computed = updates.find((u) => u.id === line.id)?.set;
      if (computed) Object.assign(set, computed);
    }
  }

  if (Object.keys(set).length === 0) return loadFilingDetail(db, entityId, filingId);
  const now = new Date();
  await atomically(db, (h) => [
    h.update(schema.form1099FilingLines).set({ ...set, updatedAt: now }).where(eq(schema.form1099FilingLines.id, line.id)),
    h.update(schema.form1099Filings).set({ updatedAt: now }).where(eq(schema.form1099Filings.id, filing.id)),
  ]);

  // Withdrawing the last pending correction puts the filing back to filed.
  if (pendingCorrection && set.status === 'excluded') {
    const remaining = (await loadLines(db, filing.id)).filter((l) => l.isCorrected && l.status === 'included');
    if (remaining.length === 0) {
      await db.update(schema.form1099Filings).set({ status: 'filed', updatedAt: now }).where(eq(schema.form1099Filings.id, filing.id));
    }
  }
  return loadFilingDetail(db, entityId, filingId);
}

// ---------------------------------------------------------------------------
// Review, generate, file
// ---------------------------------------------------------------------------

export async function reviewFiling(db: Database, entityId: string, filingId: string) {
  const filing = await loadFiling(db, entityId, filingId);
  if (filing.status !== 'draft') {
    throw new Form1099Error('conflict', `Only a draft filing can be reviewed; this one is ${filing.status}.`);
  }
  const lines = await loadLines(db, filing.id);
  const open = lines.filter((l) => l.status === 'needs_tin' || l.status === 'needs_address');
  await db
    .update(schema.form1099Filings)
    .set({ status: 'reviewed', updatedAt: new Date() })
    .where(eq(schema.form1099Filings.id, filing.id));
  return {
    unresolved: open.map((l) => ({ lineId: l.id, partyId: l.partyId, name: l.recipient?.name ?? null, status: l.status })),
  };
}

export async function generateFiling(
  db: Database,
  env: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string },
  entityId: string,
  filingId: string,
) {
  const filing = await loadFiling(db, entityId, filingId);
  if (filing.status !== 'reviewed') {
    throw new Form1099Error('conflict', `Review the filing first; this one is ${filing.status}.`);
  }
  const lines = await loadLines(db, filing.id);
  const open = lines.filter((l) => l.status === 'needs_tin' || l.status === 'needs_address');
  if (open.length > 0) {
    throw new Form1099Error('conflict', `${open.length} recipient(s) still need a TIN or an address. Fix them and refresh, or exclude them.`, {
      lines: open.map((l) => ({ lineId: l.id, partyId: l.partyId, name: l.recipient?.name ?? null, status: l.status })),
    });
  }
  const included = lines.filter((l) => l.status === 'included');
  if (included.length === 0) throw new Form1099Error('conflict', 'There is no recipient to report on this filing.');

  const keyring = requireKeyring(env);
  const parties = await db
    .select()
    .from(schema.parties)
    .where(inArray(schema.parties.id, [...new Set(included.map((l) => l.partyId))]));
  const byId = new Map(parties.map((p) => [p.id, p]));

  const now = new Date();
  const sealed: Array<{ id: string; tin: string; recipient: NonNullable<LineRow['recipient']> }> = [];
  for (const line of included) {
    const party = byId.get(line.partyId);
    const tin = party ? (await readSensitive(party, keyring)).tin : undefined;
    if (!party || !tin) {
      throw new Form1099Error('conflict', `${line.recipient?.name ?? line.partyId} has no TIN on file`, { lineId: line.id });
    }
    sealed.push({ id: line.id, tin: await encryptField(tin, keyring), recipient: snapshotRecipient(party) });
  }

  await atomically(db, (h) => [
    ...sealed.map((s) =>
      h
        .update(schema.form1099FilingLines)
        .set({ recipient: s.recipient, recipientTinEncrypted: s.tin, updatedAt: now })
        .where(eq(schema.form1099FilingLines.id, s.id)),
    ),
    h
      .update(schema.form1099Filings)
      .set({ status: 'generated', generatedAt: now, updatedAt: now })
      .where(eq(schema.form1099Filings.id, filing.id)),
  ]);
  return { lineCount: included.length };
}

export async function markFiled(
  db: Database,
  entityId: string,
  filingId: string,
  input: { confirmationNumber: string; filedAt?: Date },
) {
  const filing = await loadFiling(db, entityId, filingId);
  if (filing.status !== 'generated' && filing.status !== 'corrected') {
    throw new Form1099Error('conflict', `Generate the filing first; this one is ${filing.status}.`);
  }
  const now = new Date();
  await atomically(db, (h) => [
    h
      .update(schema.form1099FilingLines)
      .set({ status: 'filed', updatedAt: now })
      .where(and(eq(schema.form1099FilingLines.filingId, filing.id), eq(schema.form1099FilingLines.status, 'included'))),
    h
      .update(schema.form1099Filings)
      .set({ status: 'filed', filedAt: input.filedAt ?? now, confirmationNumber: input.confirmationNumber, updatedAt: now })
      .where(eq(schema.form1099Filings.id, filing.id)),
  ]);
}

// ---------------------------------------------------------------------------
// Corrections and delivery
// ---------------------------------------------------------------------------

export async function correctLine(
  db: Database,
  env: { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string },
  entityId: string,
  filingId: string,
  lineId: string,
  input: { boxes: Record<string, number>; reason: string; refreshRecipient?: boolean },
  userId: string | null,
) {
  const filing = await loadFiling(db, entityId, filingId);
  if (filing.status !== 'filed' && filing.status !== 'corrected') {
    throw new Form1099Error('conflict', `Only a filed filing can be corrected; this one is ${filing.status}. Edit it instead.`);
  }
  const form = filing.formType as Form1099Type;
  const line = await loadLine(db, filing, lineId);
  const all = await loadLines(db, filing.id);
  if (all.some((l) => l.correctionOfLineId === line.id)) {
    throw new Form1099Error('conflict', 'This line was already corrected; correct the newer line.');
  }
  if (line.status !== 'filed') {
    throw new Form1099Error('conflict', 'Only a line that was filed can be corrected; edit a pending correction instead.');
  }
  if (!input.reason.trim()) throw new Form1099Error('bad_request', 'A correction needs a reason');
  validateBoxes(input.boxes, form);

  const adjustments: LineAdjustment[] = [];
  const now = new Date();
  for (const code of new Set([...Object.keys(line.boxes), ...Object.keys(input.boxes)])) {
    const delta = cents((input.boxes[code] ?? 0) - (line.boxes[code] ?? 0));
    if (delta !== 0) adjustments.push({ box: code, amount: delta, reason: input.reason.trim(), by: userId ?? undefined, at: now.toISOString() });
  }

  let recipient = line.recipient;
  let tin = line.recipientTinEncrypted;
  if (input.refreshRecipient) {
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, line.partyId)).limit(1);
    if (!party) throw new Form1099Error('not_found', 'The vendor of this line no longer exists');
    const keyring = requireKeyring(env);
    const plain = (await readSensitive(party, keyring)).tin;
    if (!plain) throw new Form1099Error('conflict', 'The vendor has no TIN on file');
    recipient = snapshotRecipient(party);
    tin = await encryptField(plain, keyring);
  }

  const newId = generateId('f9l');
  await atomically(db, (h) => [
    h.insert(schema.form1099FilingLines).values({
      id: newId,
      entityId,
      filingId: filing.id,
      partyId: line.partyId,
      recipient,
      recipientTinEncrypted: tin,
      boxes: input.boxes,
      adjustments,
      federalWithheld: (input.boxes[withholdingBoxFor(form)] ?? 0).toFixed(2),
      stateCode: line.stateCode,
      stateIdNumber: line.stateIdNumber,
      stateIncome: line.stateIncome,
      stateWithheld: line.stateWithheld,
      status: 'included',
      isCorrected: true,
      correctionOfLineId: line.id,
      createdAt: now,
      updatedAt: now,
    }),
    h.update(schema.form1099Filings).set({ status: 'corrected', updatedAt: now }).where(eq(schema.form1099Filings.id, filing.id)),
  ]);
  return { lineId: newId };
}

export async function markLineDelivered(
  db: Database,
  entityId: string,
  filingId: string,
  lineId: string,
  method: 'print' | 'email',
) {
  const filing = await loadFiling(db, entityId, filingId);
  if (!['generated', 'filed', 'corrected'].includes(filing.status)) {
    throw new Form1099Error('conflict', 'Generate the filing before delivering copies.');
  }
  const line = await loadLine(db, filing, lineId);
  if (line.status !== 'included' && line.status !== 'filed') {
    throw new Form1099Error('conflict', 'This recipient is not on the filing.');
  }
  if (method === 'email') {
    const [party] = await db
      .select({ consent: schema.parties.form1099EDeliveryConsentAt })
      .from(schema.parties)
      .where(eq(schema.parties.id, line.partyId))
      .limit(1);
    if (!party?.consent) {
      throw new Form1099Error(
        'conflict',
        'The recipient has not agreed to electronic delivery. Record their consent first, or deliver a printed copy.',
      );
    }
  }
  const now = new Date();
  await db
    .update(schema.form1099FilingLines)
    .set({ deliveryMethod: method, deliveredAt: now, updatedAt: now })
    .where(eq(schema.form1099FilingLines.id, line.id));
  return { deliveredAt: now, deliveryMethod: method };
}

export async function deleteFiling(db: Database, entityId: string, filingId: string) {
  const filing = await loadFiling(db, entityId, filingId);
  if (filing.status !== 'draft') {
    throw new Form1099Error('conflict', `Only a draft filing can be deleted; this one is ${filing.status}.`);
  }
  const now = new Date();
  await atomically(db, (h) => [
    h.delete(schema.form1099FilingLines).where(eq(schema.form1099FilingLines.filingId, filing.id)),
    h.update(schema.form1099Filings).set({ deletedAt: now, updatedAt: now }).where(eq(schema.form1099Filings.id, filing.id)),
  ]);
  return filing;
}

/** What an entity event or audit row may say about a filing: no recipients, no TINs. */
export function filingEventData(filing: FilingRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: filing.id,
    entityId: filing.entityId,
    taxYear: filing.taxYear,
    formType: filing.formType,
    status: filing.status,
    ...extra,
  };
}

/** Lines that go into the IRIS file or the copies of a filing. */
export function linesForFile(filing: FilingRow, lines: LineRow[]): LineRow[] {
  const superseded = new Set(lines.map((l) => l.correctionOfLineId).filter((id): id is string => Boolean(id)));
  const live = lines.filter((l) => !superseded.has(l.id) && (l.status === 'included' || l.status === 'filed'));
  return filing.status === 'corrected' ? live.filter((l) => l.isCorrected && l.status === 'included') : live;
}
