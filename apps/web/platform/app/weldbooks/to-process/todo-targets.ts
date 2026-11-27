/**
 * Where each thing on the To process page leads: the panel an item opens, the
 * one primary action of a card, and the words of a hint code. Pure functions,
 * so the mapping is tested without rendering the page.
 */

import type { TodoItem, TodoKind } from '@/lib/api/domains/weldbooks';
import { getLocale } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import type { TranslationsType } from '@/lib/i18n/types';
import { withQuery } from '@/lib/with-query';

type TodoCopy = TranslationsType['weldbooksConnected']['todo'];

/** Object types of the panels a to-process item can open stacked on the page. */
const PANEL_TYPES: ReadonlySet<string> = new Set(['bank_transaction', 'invoice', 'bill', 'vat_return', 'bank_account']);

export type TodoItemTarget =
  | { kind: 'panel'; type: string; id: string }
  | { kind: 'page'; href: string }
  | { kind: 'none' };

/**
 * How an item opens. Records with a panel stack it; an inbox document opens
 * its dialog on the documents page (`?document=`); a payment has no panel yet
 * (applying credit comes with the processing view) and is shown without a link.
 */
export function todoItemTarget(item: Pick<TodoItem, 'objectType' | 'objectId'>): TodoItemTarget {
  if (PANEL_TYPES.has(item.objectType)) return { kind: 'panel', type: item.objectType, id: item.objectId };
  if (item.objectType === 'accounting_document') {
    return { kind: 'page', href: withQuery('/weldbooks/documents', `document=${encodeURIComponent(item.objectId)}`) };
  }
  return { kind: 'none' };
}

export interface TodoKindAction {
  label: string;
  href: string;
}

/**
 * The one primary action of a kind's card, or null where there is none yet
 * (unapplied credit is applied in a later phase). A VAT return that is the only
 * one to file opens its panel on the returns page; several go to the list.
 */
export function todoKindAction(
  kind: TodoKind,
  count: number,
  items: ReadonlyArray<Pick<TodoItem, 'objectId'>>,
  copy: TodoCopy,
): TodoKindAction | null {
  const label = (action: string | { one: string; other: string }) =>
    typeof action === 'string' ? action : plural(count, action, getLocale());
  switch (kind) {
    case 'bank_lines':
      // Phase 2 replaces the reconcile screen with the processing view.
      return { label: label(copy.kinds.bank_lines.action), href: '/weldbooks/banking/reconciliation' };
    case 'documents':
      return { label: label(copy.kinds.documents.action), href: '/weldbooks/documents' };
    case 'bills_to_approve':
      return { label: label(copy.kinds.bills_to_approve.action), href: '/weldbooks/bills?status=pending_approval' };
    case 'bills_due':
      return { label: label(copy.kinds.bills_due.action), href: '/weldbooks/bills?show=due' };
    case 'invoices_overdue':
      return { label: label(copy.kinds.invoices_overdue.action), href: '/weldbooks/invoices?show=overdue' };
    case 'vat_return': {
      const only = count === 1 ? items[0] : undefined;
      return {
        label: label(copy.kinds.vat_return.action),
        href: only ? withQuery('/weldbooks/vat', `stack=${encodeURIComponent(`vat_return:${only.objectId}`)}`) : '/weldbooks/vat',
      };
    }
    case 'bank_feeds':
      return { label: label(copy.kinds.bank_feeds.action), href: '/weldbooks/banking/feeds' };
    case 'duplicates':
      return { label: label(copy.kinds.duplicates.action), href: '/weldbooks/banking/transactions' };
    case 'unapplied_credit':
      return null;
  }
}

/** The translated hint of an item, or null for a code this build does not know (never the raw code). */
export function todoHintLabel(hint: string | null, copy: TodoCopy): string | null {
  if (!hint) return null;
  return (copy.hints as Readonly<Record<string, string>>)[hint] ?? null;
}

/** The translated name of a kind. */
export function todoKindTitle(kind: TodoKind, copy: TodoCopy): string {
  return copy.kinds[kind].title;
}
