import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/reconciliation/page';

interface ReconciliationSearch {
  /** The bank account whose lines are listed. */
  accountId?: string;
  /** A bank line to select on arrival (from the bank transaction panel's Match). */
  lineId?: string;
  /** The object panel stack (`?stack=type:id`), kept in the URL by `useObjectPanelUrlSync`. */
  stack?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/weldbooks/banking/reconciliation/')({
  validateSearch: (search: Record<string, unknown>): ReconciliationSearch => ({
    accountId: text(search.accountId),
    lineId: text(search.lineId),
    stack: text(search.stack),
  }),
  component: PageComponent,
});
