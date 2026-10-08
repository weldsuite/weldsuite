/**
 * Disposing of a fixed asset (sale, scrapping, trade-in).
 *
 * 1. The ledger book's schedule is rebuilt with the disposal date, so the
 *    disposal-year depreciation follows the book's convention (full-month: none
 *    in the month of disposal; mid-month: half a month).
 * 2. Depreciation of the complete months before the disposal date is posted
 *    month by month (catch-up). Any depreciation left for the month of
 *    disposal goes into the disposal entry itself.
 * 3. One entry, dated the disposal date, closes the asset: debit accumulated
 *    depreciation, debit the deposit account for the proceeds, credit the asset
 *    account for the cost, and the difference to the gain-or-loss account
 *    (credit for a gain, debit for a loss). The asset row (status `disposed`,
 *    date, proceeds, entry id) is updated in the same atomic batch.
 *
 * Tax books post nothing: their schedules are computed from the asset, which
 * now has a disposal date, so the disposal-year amounts follow. The result
 * reports each tax book's gain or loss and the section 1245 / 1250 recapture.
 */

import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { addDays, isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import { gainOnDisposal, type DisposalGain } from '@weldsuite/books-domain/us-compliance/depreciation';
import { assertPostingAllowed } from '@weldsuite/books-domain/accounting-guards';
import { accountForRole, loadEntityAccounts, postJournalEntry, type PostingLine } from '../accounting-posting';
import {
  assertPostedMatch,
  loadAsset,
  loadBooks,
  loadEntity,
  loadLedgerRows,
  refreshMacrsConventions,
  replaceLedgerRowStatements,
  scheduleContextFor,
} from './assets';
import {
  dimensionStatements,
  depreciationLines,
  loadPendingRows,
  runDepreciation,
  type PostedPeriod,
} from './depreciation-run';
import { annualSchedule, ledgerRows } from './schedules';
import {
  FixedAssetError,
  asNumber,
  dayToDate,
  entityFiscalConfig,
  fromCents,
  money,
  toCents,
  type AssetRow,
} from './shared';

const assetsTable = schema.fixedAssets;
const depTable = schema.fixedAssetDepreciation;

export interface DisposeInput {
  /** Disposal date, YYYY-MM-DD. */
  date: string;
  /** Sale proceeds; 0 for scrapping. */
  proceeds: number;
  /** Where the proceeds were received (bank, undeposited funds, receivable). Defaults to undeposited funds, else the first bank account. */
  depositAccountId?: string | null;
  /** Gain-or-loss account; defaults to the chart's `gain_loss_on_disposal` account. */
  gainLossAccountId?: string | null;
}

export interface TaxBookDisposal extends DisposalGain {
  book: string;
  stateCode: string | null;
  method: string;
  /** Depreciation taken on the book through the disposal year, section 179 and bonus included. */
  accumulated: number;
  /** The business-use share of the proceeds the gain is figured on. */
  proceeds: number;
}

export interface DisposeResult {
  asset: AssetRow;
  journalEntryId: string;
  entryNumber: string | null;
  proceeds: number;
  /** Depreciation on the ledger book through the disposal date. */
  accumulatedDepreciation: number;
  netBookValue: number;
  /** Proceeds less net book value; negative for a loss. */
  gainOrLoss: number;
  result: 'gain' | 'loss' | 'none';
  /** Depreciation entries posted to bring the asset up to the disposal date. */
  catchUp: PostedPeriod[];
  /** Depreciation for the month of disposal, posted inside the disposal entry. */
  disposalMonthDepreciation: number;
  taxBooks: TaxBookDisposal[];
}

export async function disposeFixedAsset(
  db: Database,
  args: { assetId: string; userId: string | null; input: DisposeInput },
): Promise<DisposeResult> {
  const { input } = args;
  const asset = await loadAsset(db, args.assetId);
  if (!asset) throw new FixedAssetError('Fixed asset not found', 'not_found');
  if (asset.status === 'disposed') throw new FixedAssetError('This asset has already been disposed of', 'conflict');
  if (!isIsoDate(input.date)) throw new FixedAssetError('date must be a date (YYYY-MM-DD)');
  if (input.date < asset.placedInServiceDate) throw new FixedAssetError('The asset cannot be disposed of before it was placed in service');
  if (!Number.isFinite(input.proceeds) || input.proceeds < 0) throw new FixedAssetError('proceeds cannot be negative');

  const entity = await loadEntity(db, asset.entityId);
  const config = entityFiscalConfig(entity);
  const accounts = await loadEntityAccounts(db, asset.entityId);

  const proceedsCents = toCents(input.proceeds);
  let depositAccountId: string | null = null;
  if (proceedsCents > 0) {
    if (input.depositAccountId) {
      if (!accounts.byId(input.depositAccountId)) throw new FixedAssetError('depositAccountId does not belong to this accounting entity');
      depositAccountId = input.depositAccountId;
    } else {
      const fallback = accountForRole(accounts, 'undeposited_funds') ?? accounts.bySubtype('bank');
      if (!fallback) throw new FixedAssetError('Choose the account the proceeds went to (depositAccountId)');
      depositAccountId = fallback.id;
    }
  }
  if (input.gainLossAccountId && !accounts.byId(input.gainLossAccountId)) {
    throw new FixedAssetError('gainLossAccountId does not belong to this accounting entity');
  }

  const disposalDate = dayToDate(input.date);
  await assertPostingAllowed(db, { entityId: asset.entityId, date: disposalDate, kind: 'general', affectsTax: false, userId: args.userId });

  // --- 1 + 2: the ledger book's schedule up to the disposal date --------------
  const books = await loadBooks(db, asset.id);
  const ledgerBook = books.find((book) => book.postsToLedger);
  const catchUp: PostedPeriod[] = [];
  if (ledgerBook) {
    const before = await loadLedgerRows(db, asset.id, ledgerBook.id);
    const withDisposal = ledgerRows(asset, ledgerBook, config, { disposalDate: input.date });
    assertPostedMatch(before.filter((row) => row.journalEntryId), withDisposal.rows, 'Disposing of the asset on this date');
    const now = new Date();
    await atomically(db, (h) =>
      replaceLedgerRowStatements(h, asset, ledgerBook, withDisposal.rows, before.filter((row) => row.journalEntryId), now),
    );
    try {
      const run = await runDepreciation(db, {
        entityId: asset.entityId,
        through: addDays(input.date, -1),
        userId: args.userId,
        assetId: asset.id,
        finishAssets: false,
      });
      if (run.skipped.length > 0) {
        const first = run.skipped[0]!;
        throw new FixedAssetError(`Depreciation up to the disposal date could not be posted (${first.periodEnd}): ${first.reason}`, 'conflict');
      }
      catchUp.push(...run.posted);
    } catch (err) {
      // Put the schedule back as it was; whatever was posted is the same in both.
      const posted = (await loadLedgerRows(db, asset.id, ledgerBook.id)).filter((row) => row.journalEntryId);
      const original = ledgerRows(asset, ledgerBook, config);
      await atomically(db, (h) => replaceLedgerRowStatements(h, asset, ledgerBook, original.rows, posted, new Date()));
      throw err;
    }
  }

  // --- 3: the disposal entry --------------------------------------------------
  const stub = ledgerBook ? await loadPendingRows(db, { entityId: asset.entityId, through: '9999-12-31', assetId: asset.id }) : [];
  const stubCents = stub.reduce((sum, { row }) => sum + toCents(asNumber(row.amount)), 0);
  const allRows = ledgerBook ? await loadLedgerRows(db, asset.id, ledgerBook.id) : [];
  const accumulatedCents = allRows.reduce((sum, row) => sum + toCents(asNumber(row.amount)), 0);
  const costCents = toCents(asNumber(asset.cost));
  const netBookCents = costCents - accumulatedCents;
  const diffCents = proceedsCents - netBookCents;

  let gainLossAccountId: string | null = null;
  if (diffCents !== 0) {
    const account = input.gainLossAccountId
      ? accounts.byId(input.gainLossAccountId)
      : accountForRole(accounts, 'gain_loss_on_disposal');
    if (!account) throw new FixedAssetError('Choose the gain or loss on disposal account (gainLossAccountId): this chart has no default for it');
    gainLossAccountId = account.id;
  }

  const lines: PostingLine[] = [];
  const dimensionedLines: number[] = [];
  const stubLines = depreciationLines(stub);
  lines.push(...stubLines.lines);
  const label = asset.assetNumber ? `${asset.assetNumber} ${asset.name}` : asset.name;
  if (accumulatedCents > 0) {
    dimensionedLines.push(lines.length);
    lines.push({ accountId: asset.accumulatedDepreciationAccountId, debit: fromCents(accumulatedCents), description: `Disposal ${label}: accumulated depreciation` });
  }
  if (proceedsCents > 0 && depositAccountId) {
    lines.push({ accountId: depositAccountId, debit: fromCents(proceedsCents), description: `Disposal ${label}: proceeds` });
  }
  dimensionedLines.push(lines.length);
  lines.push({ accountId: asset.assetAccountId, credit: fromCents(costCents), description: `Disposal ${label}: cost` });
  if (gainLossAccountId && diffCents !== 0) {
    dimensionedLines.push(lines.length);
    lines.push({
      accountId: gainLossAccountId,
      ...(diffCents > 0 ? { credit: fromCents(diffCents) } : { debit: fromCents(-diffCents) }),
      description: `${diffCents > 0 ? 'Gain' : 'Loss'} on disposal of ${label}`,
    });
  }
  const dimensions = [
    ...stubLines.dimensions,
    ...(asset.classId || asset.locationId
      ? dimensionedLines.map((index) => ({ index, classId: asset.classId, locationId: asset.locationId }))
      : []),
  ];

  const stubIds = stub.map(({ row }) => row.id);
  const now = new Date();
  const posted = await postJournalEntry(db, {
    entityId: asset.entityId,
    date: disposalDate,
    description: `Disposal of ${label}`,
    sourceType: 'fixed_asset',
    sourceId: asset.id,
    postingKey: `fixed_asset:${asset.id}:disposal`,
    lockKind: 'general',
    createdBy: args.userId,
    isAutomatic: false,
    lines,
    alsoWrite: (h, entry) => [
      ...(stubIds.length > 0
        ? [h.update(depTable).set({ journalEntryId: entry.journalEntryId }).where(inArray(depTable.id, stubIds))]
        : []),
      ...dimensionStatements(h, entry.journalEntryId, dimensions),
      h
        .update(assetsTable)
        .set({
          status: 'disposed',
          disposalDate: input.date,
          disposalProceeds: money(proceedsCents),
          disposalJournalEntryId: entry.journalEntryId,
          updatedAt: now,
        })
        .where(eq(assetsTable.id, asset.id)),
    ],
  });
  if (!posted.journalEntryId) throw new FixedAssetError('Nothing to post for this disposal');

  // Rows of the ledger book are all posted now; the `where` above only touched unposted ones.
  const disposed = (await loadAsset(db, asset.id)) as AssetRow;
  await refreshMacrsConventions(db, entity);

  // --- tax books --------------------------------------------------------------
  const context = await scheduleContextFor(db, entity);
  const businessUse = asNumber(asset.businessUsePercent, 100);
  const taxBooks: TaxBookDisposal[] = [];
  for (const book of books) {
    if (book.postsToLedger || book.book === 'book') continue;
    const schedule = annualSchedule(disposed, book, context);
    const accumulated = schedule.rows.length > 0 ? (schedule.rows[schedule.rows.length - 1]!.accumulated) : 0;
    const baseCost = schedule.basis.baseCost;
    const businessProceeds = Math.round(input.proceeds * businessUse) / 100;
    taxBooks.push({
      book: book.book,
      stateCode: book.stateCode,
      method: schedule.method,
      accumulated,
      proceeds: businessProceeds,
      ...gainOnDisposal(baseCost, accumulated, businessProceeds, {
        propertyType: asNumber(book.recoveryYears) === 27.5 || asNumber(book.recoveryYears) === 39 ? 'section_1250' : 'section_1245',
      }),
    });
  }

  return {
    asset: disposed,
    journalEntryId: posted.journalEntryId,
    entryNumber: posted.entryNumber,
    proceeds: fromCents(proceedsCents),
    accumulatedDepreciation: fromCents(accumulatedCents),
    netBookValue: fromCents(netBookCents),
    gainOrLoss: fromCents(diffCents),
    result: diffCents > 0 ? 'gain' : diffCents < 0 ? 'loss' : 'none',
    catchUp,
    disposalMonthDepreciation: fromCents(stubCents),
    taxBooks,
  };
}
