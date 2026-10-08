/**
 * Fixed assets: creating, changing and deleting them, with their depreciation
 * books and the stored depreciation rows of the ledger book.
 *
 * What is stored. `fixed_assets` + `fixed_asset_books` hold the asset and the
 * setup of each book. `fixed_asset_depreciation` holds one row per month (or
 * 4-4-5 period) for the ONE book that posts to the ledger; the monthly run
 * posts those rows. Federal and state books are computed on demand from the
 * book setup, so a change to another asset (the mid-quarter test) never leaves
 * stale tax rows behind.
 *
 * Changing an asset: once anything is posted (or the asset is disposed), its
 * financial facts (cost, dates, accounts, books) are frozen, because a posted
 * depreciation entry cannot silently change; name, number, notes, class and
 * location stay editable. Until then the unposted rows are rebuilt on every
 * change.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import { depreciationBasis } from '@weldsuite/books-domain/us-compliance/depreciation';
import { assertPostingAllowed } from '@weldsuite/books-domain/accounting-guards';
import {
  accountForRole,
  loadEntityAccounts,
  postJournalEntry,
  type EntityAccounts,
} from '../accounting-posting';
import {
  defaultBooks,
  normalizeBooks,
  type BookAssetFacts,
  type BookInput,
  type BookIssue,
  type NormalizedBook,
} from './books';
import {
  annualSchedule,
  ledgerRows,
  macrsConventionMap,
  type AssetWithBook,
  type LedgerRowInput,
  type ScheduleContext,
} from './schedules';
import {
  FixedAssetError,
  asNumber,
  dayToDate,
  defaultConvention,
  effectiveConvention,
  entityFiscalConfig,
  isMacrsBook,
  isoDay,
  money,
  toCents,
  toDepreciationAsset,
  toDepreciationBook,
  type AssetRow,
  type BookKind,
  type BookRow,
  type DepreciationRowRecord,
  type EntityRow,
  type MacrsConvention,
} from './shared';

const assetsTable = schema.fixedAssets;
const booksTable = schema.fixedAssetBooks;
const depTable = schema.fixedAssetDepreciation;

// ---------------------------------------------------------------------------
// Loading

export async function loadEntity(db: Database, entityId: string): Promise<EntityRow> {
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) throw new FixedAssetError('Accounting entity not found', 'not_found');
  return entity;
}

export async function loadAsset(db: Database, id: string): Promise<AssetRow | null> {
  const [asset] = await db.select().from(assetsTable).where(and(eq(assetsTable.id, id), isNull(assetsTable.deletedAt))).limit(1);
  return asset ?? null;
}

const BOOK_ORDER: Record<string, number> = { book: 0, federal: 1, state: 2 };

export async function loadBooks(db: Database, assetId: string): Promise<BookRow[]> {
  const rows = await db.select().from(booksTable).where(eq(booksTable.assetId, assetId));
  return rows.sort((a, b) => (BOOK_ORDER[a.book] ?? 9) - (BOOK_ORDER[b.book] ?? 9) || (a.stateCode ?? '').localeCompare(b.stateCode ?? ''));
}

/** Every live asset of the entity with each of its books. */
export async function loadEntityBookRows(db: Database, entityId: string): Promise<AssetWithBook[]> {
  return db
    .select({ asset: assetsTable, book: booksTable })
    .from(booksTable)
    .innerJoin(assetsTable, eq(booksTable.assetId, assetsTable.id))
    .where(and(eq(assetsTable.entityId, entityId), isNull(assetsTable.deletedAt)));
}

export async function loadLedgerRows(db: Database, assetId: string, bookId?: string): Promise<DepreciationRowRecord[]> {
  const conditions = [eq(depTable.assetId, assetId)];
  if (bookId) conditions.push(eq(depTable.bookId, bookId));
  return db.select().from(depTable).where(and(...conditions)).orderBy(depTable.periodStart);
}

/** Whether any depreciation of the asset has been posted to the ledger. */
export async function hasPostedDepreciation(db: Database, assetId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: depTable.id })
    .from(depTable)
    .where(and(eq(depTable.assetId, assetId), isNotNull(depTable.journalEntryId)))
    .limit(1);
  return Boolean(row);
}

export async function scheduleContextFor(db: Database, entity: EntityRow): Promise<ScheduleContext> {
  const config = entityFiscalConfig(entity);
  return { config, conventions: macrsConventionMap(config, await loadEntityBookRows(db, entity.id)) };
}

// ---------------------------------------------------------------------------
// Accounts and dimensions

export interface AccountIds {
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
}

export function resolveAssetAccounts(
  accounts: EntityAccounts,
  given: { assetAccountId?: string | null; accumulatedDepreciationAccountId?: string | null; depreciationExpenseAccountId?: string | null },
): AccountIds {
  const pick = (id: string | null | undefined, label: string, fallback: () => { id: string } | undefined, hint: string): string => {
    if (id) {
      if (!accounts.byId(id)) throw new FixedAssetError(`${label} does not belong to this accounting entity`);
      return id;
    }
    const found = fallback();
    if (!found) throw new FixedAssetError(`Choose a ${hint}: this chart of accounts has no default for it`);
    return found.id;
  };
  return {
    assetAccountId: pick(
      given.assetAccountId,
      'assetAccountId',
      () => accountForRole(accounts, 'fixed_assets') ?? accounts.bySubtype('fixed_assets') ?? accounts.bySubtype('fixed_asset'),
      'fixed asset account (assetAccountId)',
    ),
    accumulatedDepreciationAccountId: pick(
      given.accumulatedDepreciationAccountId,
      'accumulatedDepreciationAccountId',
      () => accountForRole(accounts, 'accumulated_depreciation'),
      'accumulated depreciation account (accumulatedDepreciationAccountId)',
    ),
    depreciationExpenseAccountId: pick(
      given.depreciationExpenseAccountId,
      'depreciationExpenseAccountId',
      () => accountForRole(accounts, 'depreciation_expense') ?? accounts.bySubtype('depreciation'),
      'depreciation expense account (depreciationExpenseAccountId)',
    ),
  };
}

async function assertDimension(db: Database, entityId: string, id: string | null | undefined, dimension: 'class' | 'location'): Promise<void> {
  if (!id) return;
  const [row] = await db
    .select({ id: schema.accountingDimensionValues.id })
    .from(schema.accountingDimensionValues)
    .where(
      and(
        eq(schema.accountingDimensionValues.id, id),
        eq(schema.accountingDimensionValues.entityId, entityId),
        eq(schema.accountingDimensionValues.dimension, dimension),
        isNull(schema.accountingDimensionValues.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new FixedAssetError(`${dimension}Id is not a ${dimension} of this accounting entity`);
}

// ---------------------------------------------------------------------------
// Input

export interface AssetInput {
  name: string;
  assetNumber?: string | null;
  description?: string | null;
  assetClass?: string | null;
  assetAccountId?: string | null;
  accumulatedDepreciationAccountId?: string | null;
  depreciationExpenseAccountId?: string | null;
  acquisitionDate: string;
  placedInServiceDate: string;
  cost: number;
  salvageValue?: number;
  businessUsePercent?: number;
  /** Vehicles and the like. Used 50% or less for business → ADS, no section 179 or bonus (stored in the books; the flag itself is not stored). */
  listedProperty?: boolean;
  billId?: string | null;
  billItemId?: string | null;
  classId?: string | null;
  locationId?: string | null;
  notes?: string | null;
  /** Life of the default `book` book; the MACRS class when there is one, else 5 years. */
  usefulLifeYears?: number;
  /** For the default federal book. */
  section179Amount?: number;
  bonusPercent?: number;
  /** Elect the reduced 40% bonus (OBBBA's first-year election) on the default federal book. */
  bonusReducedElection?: boolean;
  books?: BookInput[];
}

export interface AssetPatch {
  name?: string;
  assetNumber?: string | null;
  description?: string | null;
  assetClass?: string | null;
  assetAccountId?: string;
  accumulatedDepreciationAccountId?: string;
  depreciationExpenseAccountId?: string;
  acquisitionDate?: string;
  placedInServiceDate?: string;
  cost?: number;
  salvageValue?: number;
  businessUsePercent?: number;
  listedProperty?: boolean;
  classId?: string | null;
  locationId?: string | null;
  notes?: string | null;
  /** Replaces all books. */
  books?: BookInput[];
}

function validateDates(acquisitionDate: string, placedInServiceDate: string): void {
  if (!isIsoDate(acquisitionDate) || !isIsoDate(placedInServiceDate)) {
    throw new FixedAssetError('acquisitionDate and placedInServiceDate must be dates (YYYY-MM-DD)');
  }
  if (placedInServiceDate < acquisitionDate) {
    throw new FixedAssetError('placedInServiceDate cannot be before acquisitionDate');
  }
}

function validateAmounts(cost: number, salvage: number, businessUse: number): void {
  if (!Number.isFinite(cost) || cost <= 0) throw new FixedAssetError('cost must be greater than zero');
  if (!Number.isFinite(salvage) || salvage < 0) throw new FixedAssetError('salvageValue cannot be negative');
  if (salvage > cost) throw new FixedAssetError('salvageValue cannot exceed the cost');
  if (!Number.isFinite(businessUse) || businessUse < 0 || businessUse > 100) {
    throw new FixedAssetError('businessUsePercent is 0 to 100');
  }
}

// ---------------------------------------------------------------------------
// Building rows

interface Built {
  asset: AssetRow;
  books: BookRow[];
  ledger: { book: BookRow; rows: LedgerRowInput[] } | null;
  issues: BookIssue[];
}

function bookRowFrom(asset: AssetRow, input: NormalizedBook, id: string, now: Date): BookRow {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    entityId: asset.entityId,
    assetId: asset.id,
    book: input.book,
    stateCode: input.stateCode,
    method: input.method,
    convention: input.convention,
    recoveryYears: input.recoveryYears.toFixed(1),
    section179Amount: input.section179Amount.toFixed(2),
    bonusPercent: input.bonusPercent.toFixed(4),
    depreciableBasis: '0.00',
    postsToLedger: input.postsToLedger,
  };
}

/** Fill in each book's convention (mid-quarter test) and depreciable basis, and build the ledger rows. */
function finishBooks(
  asset: AssetRow,
  books: BookRow[],
  config: ScheduleContext['config'],
  conventions: Readonly<Record<string, MacrsConvention>>,
): { books: BookRow[]; ledger: Built['ledger']; issues: BookIssue[] } {
  const issues: BookIssue[] = [];
  const finished = books.map((book) => {
    const convention = effectiveConvention(book, asset.id, conventions);
    const basis = depreciationBasis(toDepreciationAsset(asset, {}, book), toDepreciationBook(book, convention));
    return { ...book, convention, depreciableBasis: basis.depreciableBasis.toFixed(2) } as BookRow;
  });
  const context: ScheduleContext = { config, conventions };
  for (const book of finished) {
    const schedule = annualSchedule(asset, book, context);
    for (const issue of schedule.issues) {
      issues.push({ book: book.book as BookKind, stateCode: book.stateCode, severity: issue.severity, code: issue.code, message: issue.message });
    }
  }
  const ledgerBook = finished.find((book) => book.postsToLedger);
  const ledger = ledgerBook ? { book: ledgerBook, rows: ledgerRows(asset, ledgerBook, config).rows } : null;
  return { books: finished, ledger, issues };
}

function ledgerInsertRows(asset: AssetRow, book: BookRow, rows: readonly LedgerRowInput[], now: Date, skipStarts: ReadonlySet<string> = new Set()) {
  return rows
    .filter((row) => toCents(row.amount) !== 0 && !skipStarts.has(row.periodStart))
    .map((row) => ({
      id: generateId('fad'),
      createdAt: now,
      entityId: asset.entityId,
      assetId: asset.id,
      bookId: book.id,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      amount: row.amount.toFixed(2),
      accumulated: row.accumulated.toFixed(2),
      journalEntryId: null,
    }));
}

/**
 * Statements that swap a book's unposted rows for a fresh schedule. Rows that
 * are already posted stay; the new schedule must agree with them
 * (`assertPostedMatch`).
 */
export function replaceLedgerRowStatements(
  h: Database,
  asset: AssetRow,
  book: BookRow,
  rows: readonly LedgerRowInput[],
  posted: readonly DepreciationRowRecord[],
  now: Date,
): unknown[] {
  const postedStarts = new Set(posted.map((row) => row.periodStart));
  const inserts = ledgerInsertRows(asset, book, rows, now, postedStarts);
  const statements: unknown[] = [
    h.delete(depTable).where(and(eq(depTable.assetId, asset.id), eq(depTable.bookId, book.id), isNull(depTable.journalEntryId))),
  ];
  if (inserts.length > 0) statements.push(h.insert(depTable).values(inserts));
  return statements;
}

/** Posted depreciation is history: the new schedule has to reproduce every posted row. */
export function assertPostedMatch(posted: readonly DepreciationRowRecord[], rows: readonly LedgerRowInput[], what: string): void {
  const byStart = new Map(rows.map((row) => [row.periodStart, row]));
  for (const row of posted) {
    const next = byStart.get(row.periodStart);
    if (!next || toCents(next.amount) !== toCents(asNumber(row.amount))) {
      throw new FixedAssetError(
        `${what} would change depreciation already posted for ${row.periodStart.slice(0, 7)}. Reverse the posted depreciation first, or leave this field as it is.`,
        'conflict',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Detail

/** A book's yearly schedule as the API returns it. */
export function scheduleView(schedule: ReturnType<typeof annualSchedule>) {
  return {
    method: schedule.method,
    convention: schedule.convention,
    recoveryYears: schedule.recoveryYears,
    basis: schedule.basis,
    annual: schedule.rows,
    issues: schedule.issues,
  };
}

export interface AssetDetail extends AssetRow {
  books: Array<BookRow & { schedule: ReturnType<typeof scheduleView> }>;
  ledgerRows: DepreciationRowRecord[];
  accumulatedPosted: string;
  netBookValuePosted: string;
  issues: BookIssue[];
}

export async function assetDetail(db: Database, asset: AssetRow, context?: ScheduleContext): Promise<AssetDetail> {
  const ctx = context ?? (await scheduleContextFor(db, await loadEntity(db, asset.entityId)));
  const [books, rows] = await Promise.all([loadBooks(db, asset.id), loadLedgerRows(db, asset.id)]);
  const issues: BookIssue[] = [];
  const withSchedules = books.map((book) => {
    const schedule = annualSchedule(asset, book, ctx);
    for (const issue of schedule.issues) {
      issues.push({ book: book.book as BookKind, stateCode: book.stateCode, severity: issue.severity, code: issue.code, message: issue.message });
    }
    return { ...book, schedule: scheduleView(schedule) };
  });
  const posted = rows.filter((row) => row.journalEntryId).reduce((sum, row) => sum + toCents(asNumber(row.amount)), 0);
  return {
    ...asset,
    books: withSchedules,
    ledgerRows: rows,
    accumulatedPosted: money(posted),
    netBookValuePosted: money(toCents(asNumber(asset.cost)) - posted),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Create

export interface CreateResult {
  asset: AssetRow;
  books: BookRow[];
  issues: BookIssue[];
}

export async function createFixedAsset(
  db: Database,
  args: { entityId: string; input: AssetInput; id?: string },
): Promise<CreateResult> {
  const { entityId, input } = args;
  const entity = await loadEntity(db, entityId);
  const config = entityFiscalConfig(entity);
  validateDates(input.acquisitionDate, input.placedInServiceDate);
  const salvage = input.salvageValue ?? 0;
  const businessUse = input.businessUsePercent ?? 100;
  validateAmounts(input.cost, salvage, businessUse);
  if (!input.name.trim()) throw new FixedAssetError('name is required');

  const accounts = await loadEntityAccounts(db, entityId);
  const accountIds = resolveAssetAccounts(accounts, input);
  await Promise.all([
    assertDimension(db, entityId, input.classId, 'class'),
    assertDimension(db, entityId, input.locationId, 'location'),
  ]);

  const facts: BookAssetFacts = {
    assetClass: input.assetClass ?? null,
    acquisitionDate: input.acquisitionDate,
    placedInServiceDate: input.placedInServiceDate,
    cost: input.cost,
    businessUsePercent: businessUse,
    listedProperty: Boolean(input.listedProperty),
    usefulLifeYears: input.usefulLifeYears,
    section179Amount: input.section179Amount,
    bonusPercent: input.bonusPercent,
    bonusReducedElection: input.bonusReducedElection,
  };
  const requested = input.books && input.books.length > 0 ? input.books : defaultBooks(entity, facts);
  const normalized = normalizeBooks(requested, facts);

  const now = new Date();
  const assetId = args.id ?? generateId('fa');
  const asset: AssetRow = {
    id: assetId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    entityId,
    assetNumber: input.assetNumber ?? null,
    name: input.name.trim(),
    description: input.description ?? null,
    assetClass: input.assetClass ?? null,
    ...accountIds,
    acquisitionDate: input.acquisitionDate,
    placedInServiceDate: input.placedInServiceDate,
    cost: input.cost.toFixed(2),
    salvageValue: salvage.toFixed(2),
    businessUsePercent: businessUse.toFixed(4),
    billId: input.billId ?? null,
    billItemId: input.billItemId ?? null,
    status: 'active',
    disposalDate: null,
    disposalProceeds: null,
    disposalJournalEntryId: null,
    classId: input.classId ?? null,
    locationId: input.locationId ?? null,
    notes: input.notes ?? null,
  };
  if (asset.assetNumber) {
    const [duplicate] = await db
      .select({ id: assetsTable.id })
      .from(assetsTable)
      .where(and(eq(assetsTable.entityId, entityId), eq(assetsTable.assetNumber, asset.assetNumber), isNull(assetsTable.deletedAt)))
      .limit(1);
    if (duplicate) throw new FixedAssetError(`Asset number ${asset.assetNumber} is already in use`, 'conflict');
  }

  const draftBooks = normalized.books.map((book) => bookRowFrom(asset, book, generateId('fab'), now));
  const others = await loadEntityBookRows(db, entityId);
  const conventions = macrsConventionMap(config, [...others, ...draftBooks.map((book) => ({ asset, book }))]);
  const built = finishBooks(asset, draftBooks, config, conventions);

  const ledgerInserts = built.ledger ? ledgerInsertRows(asset, built.ledger.book, built.ledger.rows, now) : [];
  await atomically(db, (h) => {
    const statements: unknown[] = [h.insert(assetsTable).values(asset), h.insert(booksTable).values(built.books)];
    if (ledgerInserts.length > 0) statements.push(h.insert(depTable).values(ledgerInserts));
    return statements;
  });
  await refreshMacrsConventions(db, entity);

  return { asset, books: built.books, issues: [...normalized.issues, ...built.issues] };
}

// ---------------------------------------------------------------------------
// Mid-quarter test results kept on the books

/**
 * Re-run the mid-quarter test over the entity's federal assets and store each
 * MACRS book's resulting convention. Called after every change to an asset: a
 * December purchase can move all of a year's assets to the mid-quarter
 * convention. The schedules and reports always recompute; the stored value is
 * for display. Returns the number of books changed.
 */
export async function refreshMacrsConventions(db: Database, entity: EntityRow): Promise<number> {
  const config = entityFiscalConfig(entity);
  const rows = await loadEntityBookRows(db, entity.id);
  const conventions = macrsConventionMap(config, rows);
  let changed = 0;
  for (const { asset, book } of rows) {
    if (!isMacrsBook(book)) continue;
    const want = conventions[asset.id] ?? defaultConvention(book);
    if (want === book.convention) continue;
    await db.update(booksTable).set({ convention: want, updatedAt: new Date() }).where(eq(booksTable.id, book.id));
    changed += 1;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Update

const COSMETIC_KEYS = ['name', 'assetNumber', 'description', 'assetClass', 'classId', 'locationId', 'notes'] as const;
const FINANCIAL_KEYS = [
  'assetAccountId',
  'accumulatedDepreciationAccountId',
  'depreciationExpenseAccountId',
  'acquisitionDate',
  'placedInServiceDate',
  'cost',
  'salvageValue',
  'businessUsePercent',
  'books',
] as const;

export interface UpdateResult {
  asset: AssetRow;
  before: AssetRow;
  books: BookRow[];
  issues: BookIssue[];
  changes: Record<string, { old: unknown; new: unknown }>;
}

export async function updateFixedAsset(db: Database, args: { assetId: string; patch: AssetPatch }): Promise<UpdateResult> {
  const before = await loadAsset(db, args.assetId);
  if (!before) throw new FixedAssetError('Fixed asset not found', 'not_found');
  const { patch } = args;
  const entity = await loadEntity(db, before.entityId);
  const config = entityFiscalConfig(entity);

  const changes: UpdateResult['changes'] = {};
  const set: Partial<typeof assetsTable.$inferInsert> = {};
  const note = (key: string, oldValue: unknown, newValue: unknown) => {
    if (oldValue !== newValue) changes[key] = { old: oldValue, new: newValue };
  };

  for (const key of COSMETIC_KEYS) {
    if (patch[key] === undefined) continue;
    if (key === 'name' && !(patch.name ?? '').trim()) throw new FixedAssetError('name cannot be empty');
    (set as Record<string, unknown>)[key] = patch[key];
    note(key, before[key], patch[key]);
  }
  if (patch.classId !== undefined) await assertDimension(db, before.entityId, patch.classId, 'class');
  if (patch.locationId !== undefined) await assertDimension(db, before.entityId, patch.locationId, 'location');
  if (patch.assetNumber && patch.assetNumber !== before.assetNumber) {
    const [duplicate] = await db
      .select({ id: assetsTable.id })
      .from(assetsTable)
      .where(and(eq(assetsTable.entityId, before.entityId), eq(assetsTable.assetNumber, patch.assetNumber), isNull(assetsTable.deletedAt)))
      .limit(1);
    if (duplicate) throw new FixedAssetError(`Asset number ${patch.assetNumber} is already in use`, 'conflict');
  }

  // Which financial fields actually change?
  const next = {
    assetAccountId: patch.assetAccountId ?? before.assetAccountId,
    accumulatedDepreciationAccountId: patch.accumulatedDepreciationAccountId ?? before.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: patch.depreciationExpenseAccountId ?? before.depreciationExpenseAccountId,
    acquisitionDate: patch.acquisitionDate ?? before.acquisitionDate,
    placedInServiceDate: patch.placedInServiceDate ?? before.placedInServiceDate,
    cost: patch.cost !== undefined ? patch.cost.toFixed(2) : before.cost,
    salvageValue: patch.salvageValue !== undefined ? patch.salvageValue.toFixed(2) : before.salvageValue,
    businessUsePercent: patch.businessUsePercent !== undefined ? patch.businessUsePercent.toFixed(4) : before.businessUsePercent,
  };
  const financialChange =
    patch.books !== undefined ||
    (Object.keys(next) as Array<keyof typeof next>).some((key) => {
      const value = key === 'cost' || key === 'salvageValue' || key === 'businessUsePercent' ? asNumber(next[key]) : next[key];
      const old = key === 'cost' || key === 'salvageValue' || key === 'businessUsePercent' ? asNumber(before[key]) : before[key];
      return value !== old;
    });

  if (!financialChange) {
    if (Object.keys(set).length > 0) {
      await db.update(assetsTable).set({ ...set, updatedAt: new Date() }).where(eq(assetsTable.id, before.id));
    }
    const asset = (await loadAsset(db, before.id)) as AssetRow;
    return { asset, before, books: await loadBooks(db, before.id), issues: [], changes };
  }

  if (before.status === 'disposed') {
    throw new FixedAssetError('A disposed asset can only have its name, number, notes, class and location changed', 'conflict');
  }
  const posted = await db
    .select()
    .from(depTable)
    .where(and(eq(depTable.assetId, before.id), isNotNull(depTable.journalEntryId)));
  if (posted.length > 0) {
    throw new FixedAssetError(
      `Depreciation has been posted for this asset, so ${FINANCIAL_KEYS.filter((k) => patch[k] !== undefined).join(', ')} can no longer change. Edit the name, number, notes, class or location, or dispose of the asset.`,
      'conflict',
    );
  }

  validateDates(next.acquisitionDate, next.placedInServiceDate);
  validateAmounts(asNumber(next.cost), asNumber(next.salvageValue), asNumber(next.businessUsePercent, 100));
  const accounts = await loadEntityAccounts(db, before.entityId);
  const accountIds = resolveAssetAccounts(accounts, next);

  const now = new Date();
  const updated: AssetRow = { ...before, ...set, ...next, ...accountIds, updatedAt: now } as AssetRow;
  for (const key of ['cost', 'salvageValue', 'businessUsePercent', 'acquisitionDate', 'placedInServiceDate', 'assetAccountId', 'accumulatedDepreciationAccountId', 'depreciationExpenseAccountId'] as const) {
    note(key, before[key], updated[key]);
  }

  const facts: BookAssetFacts = {
    assetClass: updated.assetClass,
    acquisitionDate: updated.acquisitionDate,
    placedInServiceDate: updated.placedInServiceDate,
    cost: asNumber(updated.cost),
    businessUsePercent: asNumber(updated.businessUsePercent, 100),
    listedProperty: Boolean(patch.listedProperty),
  };

  const existingBooks = await loadBooks(db, before.id);
  let draftBooks: BookRow[];
  let issues: BookIssue[] = [];
  const replaceBooks = patch.books !== undefined;
  if (replaceBooks) {
    if (patch.books!.length === 0) throw new FixedAssetError('An asset needs at least one depreciation book');
    const normalized = normalizeBooks(patch.books!, facts);
    issues = normalized.issues;
    draftBooks = normalized.books.map((book) => bookRowFrom(updated, book, generateId('fab'), now));
    changes.books = { old: existingBooks.map((b) => b.book), new: draftBooks.map((b) => b.book) };
  } else {
    draftBooks = existingBooks;
  }

  const others = (await loadEntityBookRows(db, before.entityId)).filter(({ asset }) => asset.id !== before.id);
  const conventions = macrsConventionMap(config, [...others, ...draftBooks.map((book) => ({ asset: updated, book }))]);
  const built = finishBooks(updated, draftBooks, config, conventions);

  await atomically(db, (h) => {
    const statements: unknown[] = [
      h.update(assetsTable).set({ ...set, ...next, ...accountIds, updatedAt: now }).where(eq(assetsTable.id, before.id)),
    ];
    if (replaceBooks) {
      statements.push(h.delete(depTable).where(eq(depTable.assetId, before.id)));
      statements.push(h.delete(booksTable).where(eq(booksTable.assetId, before.id)));
      statements.push(h.insert(booksTable).values(built.books));
      const rows = built.ledger ? ledgerInsertRows(updated, built.ledger.book, built.ledger.rows, now) : [];
      if (rows.length > 0) statements.push(h.insert(depTable).values(rows));
    } else {
      for (const book of built.books) {
        statements.push(
          h.update(booksTable).set({ convention: book.convention, depreciableBasis: book.depreciableBasis, updatedAt: now }).where(eq(booksTable.id, book.id)),
        );
      }
      if (built.ledger) {
        statements.push(...replaceLedgerRowStatements(h, updated, built.ledger.book, built.ledger.rows, [], now));
      }
    }
    return statements;
  });
  await refreshMacrsConventions(db, entity);

  return { asset: updated, before, books: built.books, issues: [...issues, ...built.issues], changes };
}

// ---------------------------------------------------------------------------
// Delete

export async function deleteFixedAsset(db: Database, assetId: string): Promise<AssetRow> {
  const asset = await loadAsset(db, assetId);
  if (!asset) throw new FixedAssetError('Fixed asset not found', 'not_found');
  if (asset.status === 'disposed' || asset.disposalJournalEntryId) {
    throw new FixedAssetError('A disposed asset stays on the register; it cannot be deleted', 'conflict');
  }
  if (await hasPostedDepreciation(db, assetId)) {
    throw new FixedAssetError('Depreciation has been posted for this asset, so it cannot be deleted. Dispose of it instead.', 'conflict');
  }
  const now = new Date();
  await atomically(db, (h) => [
    h.delete(depTable).where(eq(depTable.assetId, assetId)),
    h.delete(booksTable).where(eq(booksTable.assetId, assetId)),
    h.update(assetsTable).set({ deletedAt: now, updatedAt: now }).where(eq(assetsTable.id, assetId)),
  ]);
  await refreshMacrsConventions(db, await loadEntity(db, asset.entityId));
  return asset;
}

// ---------------------------------------------------------------------------
// From a bill line

export interface FromBillLineInput extends Omit<AssetInput, 'cost' | 'acquisitionDate' | 'placedInServiceDate' | 'name' | 'billId' | 'billItemId'> {
  billItemId: string;
  name?: string;
  cost?: number;
  acquisitionDate?: string;
  placedInServiceDate?: string;
  /** The line went to an expense account: move its cost to the asset account with a reclass entry. */
  reclass?: boolean;
}

export interface FromBillLineResult extends CreateResult {
  source: {
    billId: string;
    billItemId: string;
    lineAccountId: string | null;
    lineAccountCode: string | null;
    /** The bill line already debited a fixed asset account. */
    capitalized: boolean;
    /** The line debited something else, so the cost still has to be moved to the asset account. */
    reclassNeeded: boolean;
    reclassJournalEntryId: string | null;
  };
}

const isFixedAssetAccount = (account: { type: string; subtype: string | null } | undefined): boolean =>
  Boolean(account && account.type === 'asset' && (account.subtype === 'fixed_asset' || account.subtype === 'fixed_assets'));

/**
 * Create an asset from a bill line. The cost is the line amount; for a US
 * entity that includes the sales tax the vendor charged (a buyer cannot reclaim
 * it, so it is part of the cost of what was bought), elsewhere the amount
 * before reclaimable tax. The bill's own posting stays as it is: if the line
 * already went to a fixed asset account there is nothing to move; if it went to
 * an expense account, `reclass: true` posts Dr asset account / Cr that account
 * for the cost, dated the acquisition date (the bill must be approved first).
 */
export async function createFixedAssetFromBillLine(
  db: Database,
  args: { entityId: string; userId: string | null; input: FromBillLineInput },
): Promise<FromBillLineResult> {
  const { entityId, userId, input } = args;
  const [line] = await db
    .select()
    .from(schema.billItems)
    .where(and(eq(schema.billItems.id, input.billItemId), eq(schema.billItems.entityId, entityId), isNull(schema.billItems.deletedAt)))
    .limit(1);
  if (!line) throw new FixedAssetError('Bill line not found', 'not_found');
  const [bill] = await db
    .select()
    .from(schema.bills)
    .where(and(eq(schema.bills.id, line.billId), eq(schema.bills.entityId, entityId), isNull(schema.bills.deletedAt)))
    .limit(1);
  if (!bill) throw new FixedAssetError('Bill not found', 'not_found');
  if (bill.type === 'credit_note') throw new FixedAssetError('A credit note line cannot become an asset');

  const [linked] = await db
    .select({ id: assetsTable.id })
    .from(assetsTable)
    .where(and(eq(assetsTable.billItemId, line.id), isNull(assetsTable.deletedAt)))
    .limit(1);
  if (linked) throw new FixedAssetError('This bill line is already linked to a fixed asset', 'conflict');

  const entity = await loadEntity(db, entityId);
  const accounts = await loadEntityAccounts(db, entityId);
  const lineAccount = accounts.byId(line.accountId ?? bill.expenseAccountId);
  const capitalized = isFixedAssetAccount(lineAccount);

  let amount: number;
  if (input.cost !== undefined) {
    amount = input.cost;
  } else {
    const net = asNumber(line.lineTotal);
    const gross = line.lineTotalWithTax !== null ? asNumber(line.lineTotalWithTax) : net + asNumber(line.taxAmount);
    const documentAmount = entity.jurisdictionCode.toUpperCase() === 'US' ? gross : net;
    const rate = asNumber(bill.exchangeRate, 1) || 1;
    amount = bill.currency && bill.currency !== entity.baseCurrency ? documentAmount / rate : documentAmount;
  }
  amount = Math.round(amount * 100) / 100;

  const acquisitionDate = input.acquisitionDate ?? isoDay(bill.issueDate);
  if (input.reclass) {
    if (capitalized) throw new FixedAssetError('The bill line is already on a fixed asset account; there is nothing to reclassify');
    if (!lineAccount) throw new FixedAssetError('The bill line has no account to reclassify from');
    if (bill.status === 'draft' || !bill.journalEntryId) {
      throw new FixedAssetError('The bill has not been approved, so nothing is posted to reclassify. Set the line to a fixed asset account before approving it.');
    }
    await assertPostingAllowed(db, { entityId, date: dayToDate(acquisitionDate), kind: 'general', affectsTax: false, userId });
  }

  const { billItemId: _billItemId, reclass: _reclass, ...rest } = input;
  const assetId = generateId('fa');
  const created = await createFixedAsset(db, {
    entityId,
    id: assetId,
    input: {
      ...rest,
      name: input.name ?? line.description.slice(0, 255),
      cost: amount,
      acquisitionDate,
      placedInServiceDate: input.placedInServiceDate ?? acquisitionDate,
      assetAccountId: input.assetAccountId ?? (capitalized ? (lineAccount?.id ?? null) : null),
      classId: input.classId ?? line.classId ?? null,
      locationId: input.locationId ?? line.locationId ?? null,
      billId: bill.id,
      billItemId: line.id,
    },
  });

  let reclassJournalEntryId: string | null = null;
  if (input.reclass && lineAccount) {
    const posted = await postJournalEntry(db, {
      entityId,
      date: dayToDate(acquisitionDate),
      description: `Capitalize ${created.asset.name} (bill ${bill.billNumber ?? bill.id})`,
      reference: bill.billNumber ?? null,
      sourceType: 'fixed_asset',
      sourceId: assetId,
      postingKey: `fixed_asset:${assetId}:reclass`,
      lockKind: 'general',
      createdBy: userId,
      isAutomatic: false,
      lines: [
        { accountId: created.asset.assetAccountId, debit: amount, description: `Capitalize ${created.asset.name}` },
        { accountId: lineAccount.id, credit: amount, description: `Reclass from ${lineAccount.code} ${lineAccount.name}` },
      ],
    });
    reclassJournalEntryId = posted.journalEntryId;
  }

  return {
    ...created,
    source: {
      billId: bill.id,
      billItemId: line.id,
      lineAccountId: lineAccount?.id ?? null,
      lineAccountCode: lineAccount?.code ?? null,
      capitalized,
      reclassNeeded: !capitalized && !reclassJournalEntryId,
      reclassJournalEntryId,
    },
  };
}

// ---------------------------------------------------------------------------
// Listing

export interface AssetListFilters {
  entityId: string;
  status?: string;
  assetClass?: string;
  search?: string;
}

export async function accumulatedPostedByAsset(db: Database, assetIds: readonly string[]): Promise<Map<string, number>> {
  if (assetIds.length === 0) return new Map();
  const rows = await db
    .select({ assetId: depTable.assetId, total: sql<string>`coalesce(sum(${depTable.amount}), 0)` })
    .from(depTable)
    .where(and(inArray(depTable.assetId, [...assetIds]), isNotNull(depTable.journalEntryId)))
    .groupBy(depTable.assetId);
  return new Map(rows.map((row) => [row.assetId, toCents(asNumber(row.total))]));
}

export async function booksByAsset(db: Database, assetIds: readonly string[]): Promise<Map<string, BookRow[]>> {
  const result = new Map<string, BookRow[]>();
  if (assetIds.length === 0) return result;
  const rows = await db.select().from(booksTable).where(inArray(booksTable.assetId, [...assetIds]));
  for (const row of rows.sort((a, b) => (BOOK_ORDER[a.book] ?? 9) - (BOOK_ORDER[b.book] ?? 9))) {
    const list = result.get(row.assetId) ?? [];
    list.push(row);
    result.set(row.assetId, list);
  }
  return result;
}
