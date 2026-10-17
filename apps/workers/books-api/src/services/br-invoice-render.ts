/**
 * What a Brazilian invoice prints besides the common fields: a Pix BR Code for
 * the amount due (when the entity has a Pix key) and the NF-e / NFS-e it was
 * authorised as.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { brSettingsOf, buildPixPayload } from '@weldsuite/books-domain/jurisdictions/br';

type EntityRow = typeof schema.entities.$inferSelect;
type InvoiceRow = typeof schema.invoices.$inferSelect;

const FISCAL_LABELS: Record<string, string> = { nfe: 'NF-e', nfse: 'NFS-e', nfsen: 'NFS-e' };

export async function brInvoiceRenderExtras(
  db: Database,
  entity: EntityRow,
  invoice: InvoiceRow,
): Promise<{
  pix: { key: string; payload: string } | null;
  fiscalDocument: { label: string; number: string | null; accessKey: string | null } | null;
}> {
  if (entity.jurisdictionCode !== 'BR') return { pix: null, fiscalDocument: null };
  const settings = brSettingsOf(entity.jurisdictionSettings);
  const due = Number.parseFloat(invoice.balanceDue ?? invoice.total ?? '0');
  const pix =
    settings.pixKey && invoice.type !== 'credit_note' && (invoice.currency ?? entity.baseCurrency) === 'BRL' && due > 0
      ? {
          key: settings.pixKey,
          payload: buildPixPayload({
            key: settings.pixKey,
            merchantName: entity.legalName ?? entity.name,
            merchantCity: settings.pixCity ?? settings.municipalityName ?? '',
            amount: due,
            txid: invoice.invoiceNumber ?? invoice.id,
          }),
        }
      : null;

  const [doc] = await db
    .select({
      kind: schema.fiscalDocuments.kind,
      number: schema.fiscalDocuments.number,
      accessKey: schema.fiscalDocuments.accessKey,
    })
    .from(schema.fiscalDocuments)
    .where(and(eq(schema.fiscalDocuments.sourceId, invoice.id), eq(schema.fiscalDocuments.status, 'authorized')))
    .orderBy(desc(schema.fiscalDocuments.createdAt))
    .limit(1);
  const fiscalDocument = doc
    ? { label: FISCAL_LABELS[doc.kind] ?? doc.kind.toUpperCase(), number: doc.number, accessKey: doc.accessKey }
    : null;
  return { pix, fiscalDocument };
}
