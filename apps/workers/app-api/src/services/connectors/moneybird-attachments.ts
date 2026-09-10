/**
 * Download Moneybird invoice PDFs / document attachments into R2 and return
 * storage keys for `invoices.attachmentKeys` / `bills.attachmentKeys`.
 *
 * Soft-fail and budget-aware: callers never fail structured ingest because a
 * file download hit a rate limit or a draft invoice has no PDF yet.
 */

import type {
  MoneybirdBinaryDownload,
  MoneybirdClient,
  MoneybirdDocumentAttachmentKind,
} from '@weldsuite/connectors';

export const MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET = 30;

export interface MoneybirdAttachmentBudget {
  remaining: number;
}

export interface MoneybirdAttachmentSyncContext {
  client: MoneybirdClient;
  storage: R2Bucket;
  workspaceId: string;
  budget: MoneybirdAttachmentBudget;
}

function safeFilename(name: string | null | undefined, fallback: string): string {
  const raw = (name || fallback).trim() || fallback;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || fallback;
}

function attachmentKindForExternalType(externalEntityType: string): MoneybirdDocumentAttachmentKind | null {
  if (externalEntityType === 'moneybird_sales_invoice') return 'sales_invoice';
  if (externalEntityType === 'moneybird_purchase_invoice') return 'purchase_invoice';
  if (externalEntityType === 'moneybird_receipt') return 'receipt';
  return null;
}

function listAttachmentMeta(record: Record<string, unknown>): Array<{ id: string; filename: string | null }> {
  const raw = record.attachments;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; filename: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = row.id !== undefined && row.id !== null ? String(row.id) : '';
    if (!id) continue;
    const filename =
      typeof row.filename === 'string'
        ? row.filename
        : typeof row.name === 'string'
          ? row.name
          : null;
    out.push({ id, filename });
  }
  return out;
}

async function putBinary(args: {
  storage: R2Bucket;
  key: string;
  download: MoneybirdBinaryDownload;
}): Promise<string> {
  await args.storage.put(args.key, args.download.bytes, {
    httpMetadata: {
      contentType: args.download.contentType || 'application/octet-stream',
    },
  });
  return args.key;
}

/**
 * Download Moneybird files for one invoice/bill record into R2.
 * Returns storage keys, or `null` when the download budget is exhausted so the
 * caller can leave `attachmentKeys` empty and retry on a later sync.
 */
export async function syncMoneybirdDocumentAttachments(args: {
  ctx: MoneybirdAttachmentSyncContext;
  externalEntityType: string;
  externalId: string;
  record: Record<string, unknown>;
}): Promise<string[] | null> {
  const kind = attachmentKindForExternalType(args.externalEntityType);
  if (!kind) return [];

  const adminId = args.ctx.client.administrationId || 'unknown';
  const base = `workspaces/${args.ctx.workspaceId}/connectors/moneybird/${adminId}/${args.externalEntityType}/${args.externalId}`;
  const keys: string[] = [];

  const takeBudget = (): boolean => {
    if (args.ctx.budget.remaining <= 0) return false;
    args.ctx.budget.remaining -= 1;
    return true;
  };

  try {
    if (kind === 'sales_invoice') {
      if (!takeBudget()) return null;
      try {
        const pdf = await args.ctx.client.downloadSalesInvoicePdf(args.externalId);
        // Stable key so re-sync overwrites the same object.
        keys.push(
          await putBinary({
            storage: args.ctx.storage,
            key: `${base}/invoice.pdf`,
            download: pdf,
          }),
        );
      } catch (err) {
        console.warn(
          `[connectors/moneybird-attachments] sales invoice PDF ${args.externalId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    for (const att of listAttachmentMeta(args.record)) {
      if (!takeBudget()) {
        // Partial progress — keep what we have so far; empty only when nothing landed.
        return keys.length > 0 ? keys : null;
      }
      try {
        const download = await args.ctx.client.downloadDocumentAttachment({
          kind,
          documentId: args.externalId,
          attachmentId: att.id,
        });
        const filename = safeFilename(download.filename || att.filename, `attachment-${att.id}`);
        const key = `${base}/attachments/${att.id}/${filename}`;
        keys.push(await putBinary({ storage: args.ctx.storage, key, download }));
      } catch (err) {
        console.warn(
          `[connectors/moneybird-attachments] attachment ${args.externalId}/${att.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[connectors/moneybird-attachments] ${args.externalEntityType}/${args.externalId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return keys;
}
