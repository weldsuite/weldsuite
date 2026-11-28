import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/process/page';

interface ProcessSearch {
  /** The bank account whose lines are processed. */
  accountId?: string;
  /** A bank line to select on arrival (from the bank transaction panel). */
  lineId?: string;
  /** A form to open on that line: `category`, `receipt`, `transfer` or `several`. */
  action?: string;
  /** `automatic` opens "Booked automatically". */
  view?: string;
  /** The object panel stack (`?stack=type:id`), kept in the URL by `useObjectPanelUrlSync`. */
  stack?: string;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/weldbooks/banking/process/')({
  validateSearch: (search: Record<string, unknown>): ProcessSearch => ({
    accountId: text(search.accountId),
    lineId: text(search.lineId),
    action: text(search.action),
    view: text(search.view),
    stack: text(search.stack),
  }),
  component: PageComponent,
});
