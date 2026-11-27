import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../weldbooks-client', () => ({ weldbooksApi: http }));

import { batchesApi, receiptsApi } from './weldbooks-receipts';

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.get.mockResolvedValue({ data: [] });
  http.post.mockResolvedValue({ data: {} });
});

describe('the inbox documents', () => {
  it('always asks for the entity scope and a page, so the server does not answer the old first 100', async () => {
    await receiptsApi.listDocuments({ status: 'processed', page: 2, pageSize: 25 });
    expect(http.get).toHaveBeenCalledWith('/accounting-documents?scope=entity&status=processed&page=2&pageSize=25');

    await receiptsApi.listDocuments();
    expect(http.get).toHaveBeenLastCalledWith('/accounting-documents?scope=entity');
  });

  it('counts the entity, not the workspace', async () => {
    await receiptsApi.getDocumentStats();
    expect(http.get).toHaveBeenCalledWith('/accounting-documents/stats?scope=entity');
  });

  it('reads the inbox address of an entity and sets it', async () => {
    await receiptsApi.getInbox('ent 1');
    expect(http.get).toHaveBeenCalledWith('/accounting-entities/ent%201/inbox');
    await receiptsApi.setInbox('ent_1', 'books@acme.nl');
    expect(http.post).toHaveBeenCalledWith('/accounting-entities/ent_1/inbox', { email: 'books@acme.nl' });
  });
});

describe('booking a document', () => {
  it('posts the book request to the document', async () => {
    const input = {
      kind: 'receipt' as const,
      contactId: 'sup_1',
      date: '2026-11-20',
      lines: [{ description: 'Paper', accountId: 'acc_1', amount: 12.1 }],
      paidWith: { type: 'cash' as const },
    };
    await receiptsApi.bookDocument('doc_1', input);
    expect(http.post).toHaveBeenCalledWith('/accounting-documents/doc_1/book', input);
  });

  it('asks for the bank candidates with the overrides the form has, and leaves the rest out', async () => {
    await receiptsApi.getBankCandidates('doc_1', { amount: '221.00', date: '2026-11-20', contactId: undefined });
    expect(http.get).toHaveBeenCalledWith('/accounting-documents/doc_1/bank-candidates?amount=221.00&date=2026-11-20');
    await receiptsApi.getBankCandidates('doc_1');
    expect(http.get).toHaveBeenLastCalledWith('/accounting-documents/doc_1/bank-candidates');
  });

  it('reads the prefill, the duplicates and a supplier’s defaults', async () => {
    await receiptsApi.getPrefill('doc_1');
    expect(http.get).toHaveBeenLastCalledWith('/accounting-documents/doc_1/prefill');
    await receiptsApi.getDuplicates('doc_1');
    expect(http.get).toHaveBeenLastCalledWith('/accounting-documents/doc_1/duplicates');
    await receiptsApi.getBookingDefaults('sup_1');
    expect(http.get).toHaveBeenLastCalledWith('/accounting-contacts/sup_1/booking-defaults');
  });
});

describe('SEPA batches', () => {
  it('lists, reads, creates, downloads and cancels', async () => {
    await batchesApi.list({ status: 'exported', page: 1, pageSize: 50 });
    expect(http.get).toHaveBeenLastCalledWith('/payment-batches?status=exported&page=1&pageSize=50');
    await batchesApi.get('b_1');
    expect(http.get).toHaveBeenLastCalledWith('/payment-batches/b_1');
    await batchesApi.create({ bankAccountId: 'ba_1', billIds: ['x'], executionDate: '2026-12-01' });
    expect(http.post).toHaveBeenLastCalledWith('/payment-batches', { bankAccountId: 'ba_1', billIds: ['x'], executionDate: '2026-12-01' });
    await batchesApi.file('b_1');
    expect(http.get).toHaveBeenLastCalledWith('/payment-batches/b_1/file');
    await batchesApi.cancel('b_1');
    expect(http.post).toHaveBeenLastCalledWith('/payment-batches/b_1/cancel');
    await batchesApi.pendingBills();
    expect(http.get).toHaveBeenLastCalledWith('/payment-batches/pending-bills');
  });
});
