import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { TODO_KINDS } from '@/lib/api/domains/weldbooks';
import { todoHintLabel, todoItemTarget, todoKindAction, todoKindTitle } from './todo-targets';

const edition = vi.hoisted(() => ({ processing: false }));
vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => edition.processing }));

const copy = en.weldbooksConnected.todo;

beforeEach(() => {
  edition.processing = false;
});

describe('todoItemTarget', () => {
  it.each(['bank_transaction', 'invoice', 'bill', 'vat_return', 'bank_account'])('opens a %s as a stacked panel', (objectType) => {
    expect(todoItemTarget({ objectType, objectId: 'x_1' })).toEqual({ kind: 'panel', type: objectType, id: 'x_1' });
  });

  it('opens an inbox document on the documents page, which opens its dialog', () => {
    expect(todoItemTarget({ objectType: 'accounting_document', objectId: 'doc 1' })).toEqual({
      kind: 'page',
      href: '/weldbooks/documents?document=doc%201',
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

describe('todoKindTitle', () => {
  it('names every kind in both languages', () => {
    for (const kind of TODO_KINDS) {
      expect(todoKindTitle(kind, en.weldbooksConnected.todo)).not.toBe('');
      expect(todoKindTitle(kind, nl.weldbooksConnected.todo)).not.toBe('');
    }
    expect(todoKindTitle('bank_lines', nl.weldbooksConnected.todo)).toBe('Bankregels');
  });
});
