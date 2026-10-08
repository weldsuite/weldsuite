/**
 * Recording finalized documents with a provider engine (Stripe Tax, Avalara).
 *
 * WeldBooks builds its returns from its own tax ledger, so this is the
 * provider's copy: an invoice is committed after it posts, a credit memo is
 * reversed against the committed invoice. The ledger is already right by then,
 * so a failure never rolls anything back: it is recorded in `tax_warnings`
 * (`commit_failed`, `reverse_failed`, `reverse_unsupported`, `reverse_skipped`)
 * and retried by `POST /api/invoices/:id/commit-tax`.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { SalesTaxEngineError, type ReverseLine, type SalesTaxResult } from '@weldsuite/books-domain/sales-tax';
import { loadSalesTaxContext } from '@weldsuite/books-domain/sales-tax/load';
import { SalesTaxDocumentError } from './errors';
import {
  buildStoredRequest,
  loadSalesTaxEntity,
  mapCreditItemsToOriginal,
  usesSalesTax,
  type UsTaxItemInput,
} from './document-tax';
import { invoiceDocumentContext, invoiceItemToTaxItem, mergeSyncWarning } from './persist';
import type { SalesTaxRuntime } from './runtime';

export type ProviderSyncStatus = 'committed' | 'reversed' | 'already_synced' | 'not_applicable' | 'failed';

export interface ProviderSyncResult {
  status: ProviderSyncStatus;
  /** The provider's transaction reference after a successful sync. */
  ref?: string;
  /** What went wrong, as stored in `tax_warnings`. */
  warning?: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordOutcome(
  db: Database,
  invoiceId: string,
  existingWarnings: string[] | null,
  outcome: { ref: string } | { warning: string },
): Promise<void> {
  const now = new Date();
  if ('ref' in outcome) {
    await db
      .update(schema.invoices)
      .set({
        taxEngineRef: outcome.ref,
        taxCommittedAt: now,
        taxWarnings: mergeSyncWarning(existingWarnings),
        updatedAt: now,
      })
      .where(eq(schema.invoices.id, invoiceId));
    return;
  }
  await db
    .update(schema.invoices)
    .set({ taxWarnings: mergeSyncWarning(existingWarnings, outcome.warning), updatedAt: now })
    .where(eq(schema.invoices.id, invoiceId));
}

/** What the provider needs to credit: the original invoice's lines, with the net and tax this memo reverses. */
function reverseLinesFor(
  creditItems: Array<typeof schema.invoiceItems.$inferSelect>,
  originalItems: Array<typeof schema.invoiceItems.$inferSelect>,
  breakdown: NonNullable<(typeof schema.invoices.$inferSelect)['taxBreakdown']>,
): ReverseLine[] {
  const mapping = mapCreditItemsToOriginal(creditItems, originalItems);
  const byOriginal = new Map<string, ReverseLine>();
  for (const item of creditItems) {
    const originalLineId = mapping.get(item.id);
    if (!originalLineId) continue;
    const rows = breakdown.filter((r) => r.lineId === item.id);
    if (rows.length === 0) continue;
    const net = rows[0].taxableAmount + (rows[0].exemptAmount ?? 0) + (rows[0].nonTaxableAmount ?? 0);
    const tax = rows.reduce((sum, r) => sum + r.taxAmount, 0);
    const existing = byOriginal.get(originalLineId);
    if (existing) {
      existing.amount += net;
      existing.tax += tax;
    } else {
      byOriginal.set(originalLineId, { lineId: originalLineId, amount: net, tax });
    }
  }
  return [...byOriginal.values()].map((l) => ({
    ...l,
    amount: Math.round(l.amount * 100) / 100,
    tax: Math.round(l.tax * 100) / 100,
  }));
}

/**
 * Commit a finalized invoice, or reverse a finalized credit memo, at the
 * entity's provider engine. Manual-engine entities have nothing to record.
 * Never throws for a provider problem: the outcome is stored and returned.
 */
export async function syncInvoiceWithProvider(
  db: Database,
  invoiceId: string,
  runtime: SalesTaxRuntime,
): Promise<ProviderSyncResult> {
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);
  if (!invoice) throw new SalesTaxDocumentError('TAX_COMMIT_NOT_APPLICABLE', 'Invoice not found', 400);

  const entity = await loadSalesTaxEntity(db, invoice.entityId);
  if (!entity || !usesSalesTax(entity) || !invoice.taxEngine) return { status: 'not_applicable' };
  if (!invoice.journalEntryId) {
    throw new SalesTaxDocumentError(
      'TAX_COMMIT_NOT_APPLICABLE',
      'Only a finalized invoice can be recorded with the tax provider.',
      400,
    );
  }
  if (invoice.taxCommittedAt) return { status: 'already_synced', ref: invoice.taxEngineRef ?? undefined };

  const items = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNull(schema.invoiceItems.deletedAt)));

  let engineId: string;
  try {
    const ctx = await loadSalesTaxContext(db, entity.id, { decrypt: runtime.decrypt, fetch: runtime.fetch });
    engineId = ctx.engineId;
    if (invoice.type === 'credit_note') {
      if (!ctx.engine.reverse) return { status: 'not_applicable' };
      return await reverseCreditMemo(db, invoice, items, ctx.engine.reverse.bind(ctx.engine));
    }
    if (!ctx.engine.commit) return { status: 'not_applicable' };
    const taxItems: UsTaxItemInput[] = items.map((i) => ({ ...invoiceItemToTaxItem(i), id: i.id }));
    const bundle = await buildStoredRequest(db, entity, invoiceDocumentContext(invoice), taxItems, runtime);
    const result: SalesTaxResult = {
      engine: engineId,
      engineRef: invoice.taxEngineRef ?? undefined,
      calculatedAt: (invoice.taxCalculatedAt ?? new Date()).toISOString(),
      sourcing: 'none',
      lines: [],
      totalTax: Number.parseFloat(invoice.taxTotal ?? '0'),
      warnings: [],
    };
    const { ref } = await ctx.engine.commit(bundle.request, result);
    await recordOutcome(db, invoice.id, invoice.taxWarnings, { ref });
    return { status: 'committed', ref };
  } catch (err) {
    const message = describe(err);
    const unsupported = err instanceof SalesTaxEngineError && err.code === 'invalid_request' && invoice.type === 'credit_note';
    const warning = `${unsupported ? 'reverse_unsupported' : invoice.type === 'credit_note' ? 'reverse_failed' : 'commit_failed'}: ${message}`;
    await recordOutcome(db, invoice.id, invoice.taxWarnings, { warning });
    return { status: 'failed', warning };
  }
}

async function reverseCreditMemo(
  db: Database,
  invoice: typeof schema.invoices.$inferSelect,
  items: Array<typeof schema.invoiceItems.$inferSelect>,
  reverse: (
    ref: string,
    lines: ReverseLine[],
    opts: { documentNumber: string; date: string },
  ) => Promise<{ ref: string }>,
): Promise<ProviderSyncResult> {
  const [original] = invoice.creditNoteForInvoiceId
    ? await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice.creditNoteForInvoiceId)).limit(1)
    : [];
  if (!original?.taxCommittedAt || !original.taxEngineRef) {
    const warning = 'reverse_skipped: the original invoice was not recorded with the tax provider, so there is nothing to credit there';
    await recordOutcome(db, invoice.id, invoice.taxWarnings, { warning });
    return { status: 'failed', warning };
  }
  const originalItems = await db
    .select()
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, original.id), isNull(schema.invoiceItems.deletedAt)));
  const lines = reverseLinesFor(items, originalItems, invoice.taxBreakdown ?? []);
  if (lines.length === 0) return { status: 'not_applicable' };

  const { ref } = await reverse(original.taxEngineRef, lines, {
    documentNumber: invoice.invoiceNumber ?? invoice.id,
    date: invoice.issueDate.toISOString().slice(0, 10),
  });
  await recordOutcome(db, invoice.id, invoice.taxWarnings, { ref });
  return { status: 'reversed', ref };
}
