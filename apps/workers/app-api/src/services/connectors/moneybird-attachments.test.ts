import { describe, it, expect, vi } from 'vitest';
import type { MoneybirdClient } from '@weldsuite/connectors';
import {
  MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET,
  syncMoneybirdDocumentAttachments,
  type MoneybirdAttachmentSyncContext,
} from './moneybird-attachments';

function mockStorage(): R2Bucket {
  const store = new Map<string, ArrayBuffer>();
  return {
    put: vi.fn(async (key: string, value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream) => {
      const bytes =
        value instanceof ArrayBuffer
          ? value
          : ArrayBuffer.isView(value)
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : await new Response(value as BodyInit).arrayBuffer();
      store.set(key, bytes as ArrayBuffer);
      return { key } as R2Object;
    }),
    get: vi.fn(async (key: string) => {
      const bytes = store.get(key);
      if (!bytes) return null;
      return { body: bytes, arrayBuffer: async () => bytes } as unknown as R2ObjectBody;
    }),
  } as unknown as R2Bucket;
}

function mockClient(overrides?: Partial<MoneybirdClient>): MoneybirdClient {
  return {
    administrationId: 'admin-1',
    downloadSalesInvoicePdf: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      contentType: 'application/pdf',
      filename: 'inv.pdf',
    })),
    downloadDocumentAttachment: vi.fn(async () => ({
      bytes: new Uint8Array([4, 5]).buffer,
      contentType: 'application/pdf',
      filename: 'scan.pdf',
    })),
    ...overrides,
  } as unknown as MoneybirdClient;
}

describe('syncMoneybirdDocumentAttachments', () => {
  it('stores a sales invoice PDF under a deterministic R2 key', async () => {
    const storage = mockStorage();
    const client = mockClient();
    const ctx: MoneybirdAttachmentSyncContext = {
      client,
      storage,
      workspaceId: 'ws_1',
      budget: { remaining: MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET },
    };

    const keys = await syncMoneybirdDocumentAttachments({
      ctx,
      externalEntityType: 'moneybird_sales_invoice',
      externalId: 'mb-inv-1',
      record: { id: 'mb-inv-1' },
    });

    expect(keys).toEqual([
      'workspaces/ws_1/connectors/moneybird/admin-1/moneybird_sales_invoice/mb-inv-1/invoice.pdf',
    ]);
    expect(client.downloadSalesInvoicePdf).toHaveBeenCalledWith('mb-inv-1');
    expect(ctx.budget.remaining).toBe(MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET - 1);
  });

  it('stores purchase invoice attachments and soft-fails individual downloads', async () => {
    const storage = mockStorage();
    const client = mockClient({
      downloadDocumentAttachment: vi
        .fn()
        .mockRejectedValueOnce(new Error('gone'))
        .mockResolvedValueOnce({
          bytes: new Uint8Array([9]).buffer,
          contentType: 'application/pdf',
          filename: 'ok.pdf',
        }),
    });
    const ctx: MoneybirdAttachmentSyncContext = {
      client,
      storage,
      workspaceId: 'ws_1',
      budget: { remaining: 10 },
    };

    const keys = await syncMoneybirdDocumentAttachments({
      ctx,
      externalEntityType: 'moneybird_purchase_invoice',
      externalId: 'pi-1',
      record: {
        id: 'pi-1',
        attachments: [
          { id: 'a1', filename: 'bad.pdf' },
          { id: 'a2', filename: 'ok.pdf' },
        ],
      },
    });

    expect(keys).toEqual([
      'workspaces/ws_1/connectors/moneybird/admin-1/moneybird_purchase_invoice/pi-1/attachments/a2/ok.pdf',
    ]);
    expect(ctx.budget.remaining).toBe(8);
  });

  it('returns null when the download budget is exhausted before any file lands', async () => {
    const storage = mockStorage();
    const client = mockClient();
    const ctx: MoneybirdAttachmentSyncContext = {
      client,
      storage,
      workspaceId: 'ws_1',
      budget: { remaining: 0 },
    };

    const keys = await syncMoneybirdDocumentAttachments({
      ctx,
      externalEntityType: 'moneybird_sales_invoice',
      externalId: 'mb-inv-1',
      record: { id: 'mb-inv-1' },
    });

    expect(keys).toBeNull();
    expect(client.downloadSalesInvoicePdf).not.toHaveBeenCalled();
  });

  it('does not throw when the sales invoice PDF download fails', async () => {
    const storage = mockStorage();
    const client = mockClient({
      downloadSalesInvoicePdf: vi.fn(async () => {
        throw new Error('draft has no pdf');
      }),
    });
    const ctx: MoneybirdAttachmentSyncContext = {
      client,
      storage,
      workspaceId: 'ws_1',
      budget: { remaining: 5 },
    };

    const keys = await syncMoneybirdDocumentAttachments({
      ctx,
      externalEntityType: 'moneybird_sales_invoice',
      externalId: 'draft-1',
      record: { id: 'draft-1' },
    });

    expect(keys).toEqual([]);
  });
});
