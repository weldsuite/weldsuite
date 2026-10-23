import api, { QuickExpenseNotBookedError } from '@/services/api';
import {
  prefillTaxRates,
  quickExpenseLines,
  splitInclusiveTotal,
  totalFromPrefill,
} from '@/lib/quick-expense';
import type { BillPrefill } from '@/types/accounting';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require('@weldsuite/api-client/client') as {
  __client: Record<string, jest.Mock>;
  __resetClient: () => void;
};
const client = stub.__client;

/** books-api's per-line rounding: the net plus its VAT rounded to the cent. */
function booked(net: number, rate: number): number {
  return Math.round((net + Math.round(net * rate) / 100) * 100) / 100;
}

function prefill(patch: Partial<BillPrefill> = {}): BillPrefill {
  return {
    contactName: 'Albert Heijn',
    externalReference: null,
    issueDate: '2026-10-22',
    dueDate: null,
    currency: 'EUR',
    items: [],
    subtotal: null,
    taxTotal: null,
    total: null,
    sourceDocumentId: 'doc_1',
    matchedContactId: null,
    ...patch,
  };
}

describe('splitInclusiveTotal', () => {
  it('finds the net price whose rounded VAT lands on the receipt total', () => {
    const split = splitInclusiveTotal(32.48, 21);

    expect(split).toEqual({ net: 26.84, tax: 5.64, rounding: 0 });
    expect(booked(split.net, 21)).toBe(32.48);
  });

  it('lands on every total at 9% and 21% within a cent of rounding', () => {
    for (const rate of [9, 21]) {
      for (let cents = 1; cents <= 5000; cents += 7) {
        const total = cents / 100;
        const { net, rounding } = splitInclusiveTotal(total, rate);
        expect(Math.abs(rounding)).toBeLessThanOrEqual(0.01);
        expect(Math.round((booked(net, rate) + rounding) * 100)).toBe(cents);
      }
    }
  });

  it('books an untaxed total as it is', () => {
    expect(splitInclusiveTotal(12.5, 0)).toEqual({ net: 12.5, tax: 0, rounding: 0 });
  });
});

describe('receipt prefill', () => {
  // Lines: 13.75 + 9% = 14.99, 5.74 + 21% = 6.95, 2 × 1.18 + 9% = 2.57 → 24.51; the till said 24.52.
  const mixed = prefill({
    total: 24.52,
    items: [
      { description: 'Koffie', quantity: '1', unitPrice: '13.75', taxRate: '9', sortOrder: 0 },
      { description: 'Papier', quantity: '1', unitPrice: '5.74', taxRate: '21', sortOrder: 1 },
      { description: 'Melk', quantity: '2', unitPrice: '1.18', taxRate: '9', sortOrder: 2 },
    ],
  });

  it('lists the distinct rates on the receipt', () => {
    expect(prefillTaxRates(mixed)).toEqual([9, 21]);
  });

  it('prefers the receipt total and falls back to what the lines add up to', () => {
    expect(totalFromPrefill(mixed)).toBe(24.52);
    expect(totalFromPrefill({ ...mixed, total: null })).toBe(24.51);
    expect(totalFromPrefill(prefill())).toBeNull();
  });

  it('keeps a mixed-rate receipt on its own lines, with the cent of rounding on top', () => {
    const lines = quickExpenseLines({
      total: 24.52,
      taxRate: 9,
      description: 'Food',
      roundingDescription: 'Rounding',
      receiptLines: mixed.items,
    });

    expect(lines.map((line) => line.taxRate)).toEqual(['9', '21', '9', 0]);
    expect(lines[3]).toMatchObject({ description: 'Rounding', unitPrice: 0.01 });
  });

  it('books the confirmed total at one rate when the lines miss it by more than rounding', () => {
    // A discount line OCR left out: the lines add up to 24.51, the receipt says 25.
    const lines = quickExpenseLines({
      total: 25,
      taxRate: 9,
      description: 'Food',
      roundingDescription: 'Rounding',
      receiptLines: mixed.items,
    });

    expect(lines[0]).toMatchObject({ description: 'Food', quantity: 1, taxRate: 9 });
    const booked25 = lines.reduce((sum, line) => sum + booked(Number(line.unitPrice), Number(line.taxRate)), 0);
    expect(Math.round(booked25 * 100)).toBe(2500);
  });
});

describe('createQuickExpense', () => {
  beforeEach(() => {
    stub.__resetClient();
    client.get.mockImplementation((path: string) => {
      if (path.startsWith('/accounting-contacts')) {
        return Promise.resolve({ data: [{ id: 'con_1', displayName: 'Albert Heijn' }] });
      }
      if (path === '/bills/bill_1') {
        return Promise.resolve({ data: { id: 'bill_1', contactId: 'con_1', total: '32.48', balanceDue: '32.48' } });
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    client.patch.mockResolvedValue({ data: { id: 'bill_1', status: 'approved', total: '32.48' } });
  });

  it('books the total paid: net line, then approve, then the payment', async () => {
    client.post.mockImplementation((path: string) =>
      Promise.resolve({ data: { id: path === '/payments' ? 'pay_1' : 'bill_1', total: '32.48' } }),
    );

    await api.createQuickExpense({
      amount: 32.48,
      amountIncludesTax: true,
      category: 'Food',
      vendorName: 'Albert Heijn',
      taxRate: 21,
      paymentMethod: 'cash',
      date: '2026-10-22',
    });

    const bill = client.post.mock.calls.find(([path]) => path === '/bills')![1];
    expect(bill.items).toEqual([
      expect.objectContaining({ description: 'Food', unitPrice: '26.84', taxRate: '21' }),
    ]);
    expect(client.patch).toHaveBeenCalledWith('/bills/bill_1/approve');
    const payment = client.post.mock.calls.find(([path]) => path === '/payments')![1];
    expect(payment).toMatchObject({ type: 'sent', billId: 'bill_1', amount: '32.48', paymentMethod: 'cash' });
  });

  it('uses the supplier OCR matched instead of looking one up by name', async () => {
    client.post.mockResolvedValue({ data: { id: 'bill_1', total: '32.48' } });

    await api.createQuickExpense({
      amount: 32.48,
      amountIncludesTax: true,
      category: 'Food',
      vendorName: 'AH Damrak',
      contactId: 'con_matched',
      currency: 'EUR',
      taxRate: 21,
    });

    const bill = client.post.mock.calls.find(([path]) => path === '/bills')![1];
    expect(bill).toMatchObject({ contactId: 'con_matched', currency: 'EUR' });
    expect(client.get).not.toHaveBeenCalledWith(expect.stringContaining('/accounting-contacts'));
  });

  it('reports a bill it could not book, so the expense is not saved twice', async () => {
    client.post.mockResolvedValue({ data: { id: 'bill_1', total: '32.48' } });
    client.patch.mockRejectedValue(new Error('Fiscal period is closed'));

    const attempt = api.createQuickExpense({
      amount: 32.48,
      amountIncludesTax: true,
      category: 'Food',
      vendorName: 'Albert Heijn',
      taxRate: 21,
    });

    await expect(attempt).rejects.toBeInstanceOf(QuickExpenseNotBookedError);
    await expect(attempt).rejects.toMatchObject({ bill: { id: 'bill_1' }, message: 'Fiscal period is closed' });
  });

  describe('with a photo scanned offline', () => {
    const KEY = 'workspaces/org_1/accounting-documents/general/1_x/receipt-1.png';
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('stores the photo first and links it to the bill', async () => {
      globalThis.fetch = jest.fn((url: string) =>
        Promise.resolve(
          url === 'file:///cache/receipt.png'
            ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }
            : { ok: true },
        ),
      ) as unknown as typeof fetch;
      client.post.mockImplementation((path: string) => {
        if (path === '/storage/generate-upload-url') {
          return Promise.resolve({ success: true, uploadUrl: 'https://up/x', uploadToken: 'upl_1', fileKey: KEY });
        }
        if (path === '/accounting-documents') return Promise.resolve({ data: { id: 'doc_9' } });
        return Promise.resolve({ data: { id: 'bill_1', total: '32.48' }, success: true });
      });

      const [result] = await api.uploadOfflineQueue([
        {
          type: 'expense',
          data: {
            amount: 32.48,
            amountIncludesTax: true,
            category: 'Food',
            taxRate: 21,
            receipt: { localUri: 'file:///cache/receipt.png', fileName: 'receipt-1.png', mimeType: 'image/png' },
          },
        },
      ]);

      expect(result).toMatchObject({ type: 'expense', id: 'bill_1' });
      const document = client.post.mock.calls.find(([path]) => path === '/accounting-documents')![1];
      expect(document).toMatchObject({ fileKey: KEY, mimeType: 'image/png' });
      const bill = client.post.mock.calls.find(([path]) => path === '/bills')![1];
      expect(bill.sourceDocumentId).toBe('doc_9');
    });

    it('keeps the stored photo for the retry when the bill fails, so it is not stored twice', async () => {
      globalThis.fetch = jest.fn((url: string) =>
        Promise.resolve(
          url === 'file:///cache/receipt.png'
            ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }
            : { ok: true },
        ),
      ) as unknown as typeof fetch;
      client.post.mockImplementation((path: string) => {
        if (path === '/storage/generate-upload-url') {
          return Promise.resolve({ success: true, uploadUrl: 'https://up/x', uploadToken: 'upl_1', fileKey: KEY });
        }
        if (path === '/accounting-documents') return Promise.resolve({ data: { id: 'doc_9' } });
        if (path === '/bills') return Promise.reject(new Error('Network request failed'));
        return Promise.resolve({ success: true });
      });

      const [result] = await api.uploadOfflineQueue([
        {
          type: 'expense',
          data: {
            amount: 32.48,
            amountIncludesTax: true,
            category: 'Food',
            taxRate: 21,
            receipt: { localUri: 'file:///cache/receipt.png', fileName: 'receipt-1.png', mimeType: 'image/png' },
          },
        },
      ]);

      expect(result).toMatchObject({
        type: 'expense',
        error: 'Network request failed',
        patch: { documentId: 'doc_9', receipt: null },
      });
    });

    it('books the expense without the photo once the OS has cleared it', async () => {
      globalThis.fetch = jest.fn(() => Promise.reject(new Error('no such file'))) as unknown as typeof fetch;
      client.post.mockResolvedValue({ data: { id: 'bill_1', total: '32.48' } });

      const [result] = await api.uploadOfflineQueue([
        {
          type: 'expense',
          data: {
            amount: 32.48,
            amountIncludesTax: true,
            category: 'Food',
            taxRate: 21,
            receipt: { localUri: 'file:///cache/gone.png', fileName: 'gone.png', mimeType: 'image/png' },
          },
        },
      ]);

      expect(result).toMatchObject({ type: 'expense', id: 'bill_1' });
      const bill = client.post.mock.calls.find(([path]) => path === '/bills')![1];
      expect(bill.sourceDocumentId).toBeUndefined();
    });
  });

  it('does not keep a queued expense whose bill exists but was not booked', async () => {
    client.post.mockResolvedValue({ data: { id: 'bill_1', total: '32.48' } });
    client.patch.mockRejectedValue(new Error('Fiscal period is closed'));

    const [result] = await api.uploadOfflineQueue([
      { type: 'expense', data: { amount: 32.48, amountIncludesTax: true, category: 'Food', taxRate: 21 } },
    ]);

    expect(result).toMatchObject({ type: 'expense', id: 'bill_1' });
    expect(result.error).toBeUndefined();
  });
});
