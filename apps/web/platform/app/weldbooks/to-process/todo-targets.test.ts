import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { TODO_KINDS } from '@/lib/api/domains/weldbooks';
import {
  questionAnswerTarget,
  questionReceiptHref,
  todoHintLabel,
  todoItemTarget,
  todoKindAction,
  todoKindSummary,
  todoKindTitle,
} from './todo-targets';

const edition = vi.hoisted(() => ({ processing: false }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => edition.processing }));

const copy = en.weldbooksConnected.todo;

beforeEach(() => {
  edition.processing = false;
});

describe('todoItemTarget', () => {
  it.each(['bank_transaction', 'invoice', 'bill', 'vat_return', 'bank_account', 'weldbooks_contact'])('opens a %s as a stacked panel', (objectType) => {
    expect(todoItemTarget({ objectType, objectId: 'x_1' })).toEqual({ kind: 'panel', type: objectType, id: 'x_1' });
  });

  it('opens an inbox document on the documents page, which opens its dialog', () => {
    expect(todoItemTarget({ objectType: 'accounting_document', objectId: 'doc 1' })).toEqual({
      kind: 'page',
      href: '/weldbooks/documents?document=doc%201',
    });
  });

  it('opens an inbox document on the review screen where the edition has receipts', () => {
    edition.processing = true;
    expect(todoItemTarget({ objectType: 'accounting_document', objectId: 'doc 1' })).toEqual({
      kind: 'page',
      href: '/weldbooks/documents/doc%201/review',
    });
  });

  it('opens a question on an inbox document on its dialog, which holds the document chat, not the review screen', () => {
    edition.processing = true;
    expect(todoItemTarget({ objectType: 'accounting_document', objectId: 'doc 1', hint: 'question' })).toEqual({
      kind: 'page',
      href: '/weldbooks/documents?document=doc%201',
    });
  });

  it('opens a question on a contact as the contact panel', () => {
    expect(todoItemTarget({ objectType: 'weldbooks_contact', objectId: 'prt_1', hint: 'question' })).toEqual({
      kind: 'panel',
      type: 'weldbooks_contact',
      id: 'prt_1',
    });
  });

  it('opens a missing receipt as its bank line', () => {
    expect(todoItemTarget({ objectType: 'bank_transaction', objectId: 'btx_9' })).toEqual({
      kind: 'panel',
      type: 'bank_transaction',
      id: 'btx_9',
    });
  });

  it('opens a payment (unapplied credit) through its contact, and has no link for an unknown type', () => {
    expect(todoItemTarget({ objectType: 'payment', objectId: 'pay_1' })).toEqual({ kind: 'credit', paymentId: 'pay_1' });
    expect(todoItemTarget({ objectType: 'spaceship', objectId: 's_1' })).toEqual({ kind: 'none' });
  });
});

describe('todoKindAction', () => {
  const action = (kind: (typeof TODO_KINDS)[number], count = 4, items: Array<{ objectId: string }> = []) =>
    todoKindAction(kind, count, items, copy);

  it('processes bank lines on the reconcile screen, with the count in the label', () => {
    expect(action('bank_lines', 12)).toEqual({ label: 'Process 12 lines', href: '/weldbooks/banking/reconciliation' });
    expect(action('bank_lines', 1)?.label).toBe('Process 1 line');
  });

  it('processes bank lines in the processing view where the edition has it', () => {
    edition.processing = true;
    expect(action('bank_lines', 12)).toEqual({ label: 'Process 12 lines', href: '/weldbooks/banking/process' });
  });

  it('checks documents on the documents page', () => {
    expect(action('documents', 3)).toEqual({ label: 'Check 3 documents', href: '/weldbooks/documents' });
    expect(action('documents', 1)?.label).toBe('Check 1 document');
  });

  it('sends bills and invoices to their lists, already filtered', () => {
    expect(action('bills_to_approve')?.href).toBe('/weldbooks/bills?status=pending_approval');
    expect(action('bills_due')?.href).toBe('/weldbooks/bills?show=due');
    expect(action('invoices_overdue')?.href).toBe('/weldbooks/invoices?show=overdue');
  });

  it('opens one undelivered invoice in place, and several as a list of the bounced ones', () => {
    expect(todoKindAction('invoices_undelivered', 1, [{ objectId: 'inv_9' }], copy)).toEqual({
      label: 'Open the invoice',
      href: '/weldbooks/invoices?stack=invoice%3Ainv_9',
    });
    expect(todoKindAction('invoices_undelivered', 3, [{ objectId: 'inv_1' }], copy)).toEqual({
      label: 'Review 3 invoices',
      href: '/weldbooks/invoices?show=undelivered',
    });
  });

  it('sends bank connections to the feeds page and duplicates to the transactions list', () => {
    expect(action('bank_feeds')?.href).toBe('/weldbooks/banking/feeds');
    expect(action('duplicates')?.href).toBe('/weldbooks/banking/transactions');
  });

  it('opens the VAT return panel when one return is waiting, the returns list when there are several', () => {
    expect(action('vat_return', 1, [{ objectId: 'vat_9' }])?.href).toBe('/weldbooks/vat?stack=vat_return%3Avat_9');
    expect(action('vat_return', 2, [{ objectId: 'vat_9' }, { objectId: 'vat_8' }])?.href).toBe('/weldbooks/vat');
    expect(action('vat_return', 1, [])?.href).toBe('/weldbooks/vat');
  });

  it('has no action for unapplied credit yet', () => {
    expect(action('unapplied_credit')).toBeNull();
  });

  it('says the actions in Dutch', () => {
    expect(todoKindAction('bank_lines', 12, [], nl.weldbooksConnected.todo)?.label).toBe('12 regels verwerken');
    expect(todoKindAction('documents', 1, [], nl.weldbooksConnected.todo)?.label).toBe('1 document controleren');
  });
});

describe('todoHintLabel', () => {
  const codes = [
    'possible_match',
    'possible_duplicate',
    'missing_receipt',
    'ocr_failed',
    'awaiting_approval',
    'overdue',
    'overdue_partial',
    'due_soon',
    'not_filed',
    'rejected',
    'connection_error',
    'reauth_required',
    'consent_expiring',
    'unapplied_credit',
    // Phase 4a (Rust only).
    'undelivered',
    'reminder_due',
    // Phase 7 (Rust only): a question waiting for an answer.
    'question',
  ];

  it.each(codes)('translates %s into words in both languages, never the raw code', (code) => {
    for (const locale of [en, nl]) {
      const label = todoHintLabel(code, locale.weldbooksConnected.todo);
      expect(label).toBeTruthy();
      expect(label).not.toBe(code);
      expect(label).not.toMatch(/_/);
    }
  });

  it('shows nothing for no hint or a code this build does not know', () => {
    expect(todoHintLabel(null, copy)).toBeNull();
    expect(todoHintLabel('brand_new_code', copy)).toBeNull();
  });

  it('has a hint for every code the backend sends, in English and Dutch alike', () => {
    expect(Object.keys(en.weldbooksConnected.todo.hints).sort()).toEqual([...codes].sort());
    expect(Object.keys(nl.weldbooksConnected.todo.hints).sort()).toEqual([...codes].sort());
  });
});

describe('missing receipts', () => {
  it('says what the count counts, in both languages', () => {
    expect(todoKindSummary('missing_receipts', 12, en.weldbooksConnected.todo)).toBe('12 expenses without a receipt');
    expect(todoKindSummary('missing_receipts', 1, en.weldbooksConnected.todo)).toBe('1 expense without a receipt');
    expect(todoKindSummary('missing_receipts', 12, nl.weldbooksConnected.todo)).toBe('12 uitgaven zonder bon');
    expect(todoKindSummary('bank_lines', 12, en.weldbooksConnected.todo)).toBeNull();
  });

  it('leads to the processing view, or to the lines where the edition lacks it', () => {
    expect(todoKindAction('missing_receipts', 3, [], copy)?.href).toBe('/weldbooks/banking/transactions');
    edition.processing = true;
    expect(todoKindAction('missing_receipts', 3, [], copy)).toEqual({ label: 'Add receipts', href: '/weldbooks/banking/process' });
  });
});

describe('todoKindTitle', () => {
  it('names every kind in both languages', () => {
    for (const kind of TODO_KINDS) {
      expect(todoKindTitle(kind, en.weldbooksConnected.todo)).not.toBe('');
      expect(todoKindTitle(kind, nl.weldbooksConnected.todo)).not.toBe('');
    }
    expect(todoKindTitle('bank_lines', nl.weldbooksConnected.todo)).toBe('Bankregels');
  });
});

describe('questions', () => {
  it('has a card title, an action and a hint in both languages', () => {
    expect(todoKindTitle('questions', en.weldbooksConnected.todo)).toBe('Questions from your accountant');
    expect(todoKindTitle('questions', nl.weldbooksConnected.todo)).toBe('Vragen van je boekhouder');
    expect(todoKindAction('questions', 3, [], copy)).toEqual({ label: 'See all questions', href: '/weldbooks/questions' });
    expect(todoHintLabel('question', copy)).toBe('Waiting for your answer');
    expect(todoHintLabel('question', nl.weldbooksConnected.todo)).toBe('Wacht op je antwoord');
  });

  it.each([
    ['invoice', 'invoice'],
    ['bill', 'bill'],
    ['bank_transaction', 'bank_transaction'],
    ['vat_return', 'vat_return'],
    ['accounting_contact', 'weldbooks_contact'],
  ] as const)('answers a question on a %s in the record panel, on its Chat tab', (recordType, type) => {
    expect(questionAnswerTarget({ recordType, recordId: 'r_1' })).toEqual({ kind: 'panel', type, id: 'r_1', initialTab: 'chat' });
  });

  it('answers a question on an inbox document on the documents page', () => {
    expect(questionAnswerTarget({ recordType: 'accounting_document', recordId: 'doc 1' })).toEqual({
      kind: 'page',
      href: '/weldbooks/documents?document=doc%201',
    });
  });

  it('adds a document to a bank line in the processing view, and to no other record', () => {
    expect(questionReceiptHref({ recordType: 'bank_transaction', recordId: 'btx 1' })).toBe(
      '/weldbooks/banking/process?lineId=btx%201&action=receipt',
    );
    expect(questionReceiptHref({ recordType: 'invoice', recordId: 'inv_1' })).toBeNull();
    expect(questionReceiptHref({ recordType: 'accounting_document', recordId: 'doc_1' })).toBeNull();
  });
});
