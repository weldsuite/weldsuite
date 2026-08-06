/**
 * Covers the translation layer between app-api's wire format and the models the
 * screens consume — the part most likely to drift when a route changes.
 */

import api from '@/services/api';

// moduleNameMapper points `@weldsuite/api-client/client` at __mocks__/api-client-stub.js,
// so a plain require resolves to the very module — and therefore the very client
// instance — that services/api.ts captured at import time. (`jest.requireMock`
// would hand back a separate auto-mock whose implementations the service never sees.)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stub = require('@weldsuite/api-client/client') as {
  __client: Record<string, jest.Mock>;
  __resetClient: () => void;
};
const client = stub.__client;
const resetClient = stub.__resetClient;

/** Route GETs by path prefix so a test can script several endpoints at once. */
function routeGet(routes: Record<string, unknown>) {
  client.get.mockImplementation((path: string) => {
    const match = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!match) throw new Error(`Unexpected GET ${path}`);
    return Promise.resolve(routes[match]);
  });
}

beforeEach(() => {
  resetClient();
});

describe('getDashboard', () => {
  it('parses the decimal strings into numbers for the KPI grid', async () => {
    routeGet({
      '/accounting-dashboard': {
        data: {
          revenue: { month: '1500.50', year: '18000' },
          expenses: { month: '400', year: '4800' },
          profit: { month: '1100.50', year: '13200' },
          receivables: {
            outstanding: '2500',
            outstandingCount: 4,
            overdue: '750',
            overdueCount: 1,
          },
          payables: { outstanding: '300', outstandingCount: 2 },
          pendingDocuments: 3,
          bankAccounts: [{ id: 'ba_1', name: 'Main', currentBalance: '5000.25', currency: 'EUR' }],
          currency: 'EUR',
        },
      },
      '/invoices': { data: [{ id: 'inv_1' }], pagination: { totalCount: 1, hasMore: false, cursor: null } },
    });

    const dashboard = await api.getDashboard();

    expect(dashboard.revenue.month).toBe(1500.5);
    expect(dashboard.receivables.overdueCount).toBe(1);
    expect(dashboard.payables.outstanding).toBe(300);
    expect(dashboard.pendingDocuments).toBe(3);
    expect(dashboard.bankAccounts[0].balance).toBe(5000.25);
    expect(dashboard.recentInvoices).toHaveLength(1);
  });

  it('defaults every figure to zero when the dashboard payload is empty', async () => {
    routeGet({
      '/accounting-dashboard': { data: {} },
      '/invoices': { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } },
    });

    const dashboard = await api.getDashboard();

    expect(dashboard.revenue.month).toBe(0);
    expect(dashboard.receivables.outstanding).toBe(0);
    expect(dashboard.currency).toBe('EUR');
    expect(dashboard.bankAccounts).toEqual([]);
  });
});

describe('getVatReturns', () => {
  const rows = {
    data: [
      {
        id: 'vat_1',
        status: 'filed',
        periodStart: '2026-04-01T00:00:00.000Z',
        periodEnd: '2026-06-30T00:00:00.000Z',
        periodLabel: '2026-Q2',
        rubrieken: { r5a: '1000', r5b: '400', r5c: '600' },
      },
      {
        id: 'vat_2',
        status: 'draft',
        periodStart: '2025-01-01T00:00:00.000Z',
        rubrieken: { r5a: '500', r5b: '200' },
      },
    ],
  };

  it("maps app-api's `filed` onto the `submitted` status the screens use", async () => {
    routeGet({ '/vat-returns': rows });
    const returns = await api.getVatReturns();
    expect(returns[0].status).toBe('submitted');
    expect(returns[1].status).toBe('draft');
  });

  it('derives the net amount from r5c, or from r5a − r5b when r5c is absent', async () => {
    routeGet({ '/vat-returns': rows });
    const returns = await api.getVatReturns();
    expect(returns[0].netAmount).toBe(600);
    expect(returns[1].netAmount).toBe(300);
  });

  it('falls back to a YYYY-MM period label when the row has none', async () => {
    routeGet({ '/vat-returns': rows });
    const returns = await api.getVatReturns();
    expect(returns[0].period).toBe('2026-Q2');
    expect(returns[1].period).toBe('2025-01');
  });

  it('filters by year client-side, since the endpoint takes no params', async () => {
    routeGet({ '/vat-returns': rows });
    const returns = await api.getVatReturns({ year: 2026 });
    expect(returns).toHaveLength(1);
    expect(returns[0].id).toBe('vat_1');
  });
});

describe('createInvoice', () => {
  it('reuses an existing contact matched by display name', async () => {
    routeGet({
      '/accounting-contacts': {
        data: [{ id: 'con_1', displayName: 'Acme B.V.' }],
        pagination: { totalCount: 1, hasMore: false, cursor: null },
      },
    });
    client.post.mockResolvedValue({ data: { id: 'inv_1' } });

    await api.createInvoice({
      contactName: 'acme b.v.', // case-insensitive match
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      items: [{ description: 'Consulting', quantity: 2, unitPrice: 100, taxRate: 21 }],
    });

    // Only the invoice POST — no contact was created.
    expect(client.post).toHaveBeenCalledTimes(1);
    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/invoices');
    expect(body.contactId).toBe('con_1');
  });

  it('creates a contact when no name matches', async () => {
    routeGet({
      '/accounting-contacts': { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } },
    });
    client.post
      .mockResolvedValueOnce({ data: { id: 'con_new', displayName: 'New Co' } })
      .mockResolvedValueOnce({ data: { id: 'inv_2' } });

    await api.createInvoice({
      contactName: 'New Co',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      items: [{ description: 'Work', unitPrice: 50 }],
    });

    expect(client.post.mock.calls[0][0]).toBe('/accounting-contacts');
    expect(client.post.mock.calls[1][0]).toBe('/invoices');
    expect(client.post.mock.calls[1][1].contactId).toBe('con_new');
  });

  it('sends line-item numbers as the strings app-api requires', async () => {
    routeGet({
      '/accounting-contacts': {
        data: [{ id: 'con_1', displayName: 'Acme' }],
        pagination: { totalCount: 1, hasMore: false, cursor: null },
      },
    });
    client.post.mockResolvedValue({ data: { id: 'inv_3' } });

    await api.createInvoice({
      contactName: 'Acme',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      items: [{ description: 'Item', quantity: 2, unitPrice: 100, taxRate: 21 }],
    });

    const [, body] = client.post.mock.calls[0];
    expect(body.items[0]).toMatchObject({
      description: 'Item',
      quantity: '2',
      unitPrice: '100',
      taxRate: '21',
      sortOrder: 0,
    });
  });
});

describe('recordInvoicePayment', () => {
  it('settles the full open balance when no amount is given', async () => {
    routeGet({ '/invoices/inv_1': { data: { id: 'inv_1', balanceDue: '250.00', total: '500.00' } } });
    client.post.mockResolvedValue({ data: { id: 'pay_1' } });

    await api.recordInvoicePayment('inv_1');

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/invoices/inv_1/record-payment');
    expect(body.amount).toBe('250.00');
  });

  it('honours a partial amount without fetching the invoice', async () => {
    client.post.mockResolvedValue({ data: { id: 'pay_2' } });

    await api.recordInvoicePayment('inv_1', { amount: 100, paymentMethod: 'card' });

    expect(client.get).not.toHaveBeenCalled();
    const [, body] = client.post.mock.calls[0];
    expect(body.amount).toBe('100');
    expect(body.paymentMethod).toBe('card');
  });
});

describe('recordBillPayment', () => {
  it('refuses to post a payment for a bill with no contact', async () => {
    routeGet({ '/bills/bill_1': { data: { id: 'bill_1', balanceDue: '100', contactId: null } } });

    await expect(api.recordBillPayment('bill_1')).rejects.toThrow(/contact is required/i);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('posts an outgoing payment linked to the bill', async () => {
    routeGet({
      '/bills/bill_1': { data: { id: 'bill_1', balanceDue: '80.00', contactId: 'con_9' } },
    });
    client.post.mockResolvedValue({ data: { id: 'pay_3' } });

    await api.recordBillPayment('bill_1');

    const [path, body] = client.post.mock.calls[0];
    expect(path).toBe('/payments');
    expect(body).toMatchObject({ type: 'sent', amount: '80.00', billId: 'bill_1', contactId: 'con_9' });
  });
});

describe('getUnmatchedTransactions', () => {
  it('inlines suggestions and degrades to an empty list when a lookup fails', async () => {
    client.get.mockImplementation((path: string) => {
      if (path.startsWith('/bank-transactions?')) {
        return Promise.resolve({
          data: [
            { id: 'tx_1', amount: '-42.50', description: 'Shell' },
            { id: 'tx_2', amount: '100', description: 'Payment' },
          ],
          pagination: { totalCount: 2, hasMore: false, cursor: null },
        });
      }
      if (path === '/bank-transactions/tx_1/suggestions') {
        return Promise.resolve({
          data: [
            { id: 'bill_1', type: 'bill', number: 'B-001', contactName: 'Shell', amount: '42.50', confidence: '0.92' },
          ],
        });
      }
      // tx_2's suggestion lookup fails — that row must still render.
      return Promise.reject(new Error('boom'));
    });

    const rows = await api.getUnmatchedTransactions();

    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe(-42.5);
    expect(rows[0].suggestedMatches[0]).toMatchObject({
      id: 'bill_1',
      type: 'bill',
      amount: 42.5,
      confidence: 0.92,
    });
    expect(rows[0].suggestedMatches[0].description).toBe('Bill · B-001 · Shell');
    expect(rows[1].suggestedMatches).toEqual([]);
  });
});

describe('uploadOfflineQueue', () => {
  it('reports per-item outcomes so failures stay queued', async () => {
    routeGet({
      '/accounting-contacts': { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } },
    });
    client.post.mockImplementation((path: string) => {
      if (path === '/accounting-documents') return Promise.resolve({ data: { id: 'doc_1' } });
      if (path === '/accounting-contacts') return Promise.resolve({ data: { id: 'con_1' } });
      return Promise.reject(new Error('bill rejected'));
    });

    const results = await api.uploadOfflineQueue([
      { type: 'document', data: { fileName: 'receipt.jpg' } },
      { type: 'expense', data: { amount: '12.50', category: 'food' } },
      { type: 'mystery', data: {} },
    ]);

    expect(results[0]).toMatchObject({ index: 0, type: 'document', id: 'doc_1' });
    expect(results[1]).toMatchObject({ index: 1, type: 'expense' });
    expect(results[1].error).toBe('bill rejected');
    expect(results[2]).toMatchObject({ index: 2, error: 'Unknown item type' });
  });
});

describe('getContacts', () => {
  it('maps the legacy "vendor" filter onto the accounting role "supplier"', async () => {
    routeGet({
      '/accounting-contacts': { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } },
    });

    await api.getContacts({ type: 'vendor' });

    expect(client.get.mock.calls[0][0]).toContain('role=supplier');
  });

  it('normalises displayName and role onto the shape the screens read', async () => {
    routeGet({
      '/accounting-contacts': {
        data: [{ id: 'con_1', displayName: 'Acme B.V.', email: 'a@acme.com', role: 'supplier' }],
        pagination: { totalCount: 1, hasMore: false, cursor: null },
      },
    });

    const [contact] = await api.getContacts();

    expect(contact).toMatchObject({ id: 'con_1', name: 'Acme B.V.', type: 'supplier' });
  });
});

describe('getEntities', () => {
  it('defaults jurisdiction and currency so the gate never renders blanks', async () => {
    routeGet({ '/accounting-entities': { data: [{ id: 'ent_1', name: 'Acme' }] } });

    const [entity] = await api.getEntities();

    expect(entity).toMatchObject({
      id: 'ent_1',
      name: 'Acme',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
    });
  });
});
