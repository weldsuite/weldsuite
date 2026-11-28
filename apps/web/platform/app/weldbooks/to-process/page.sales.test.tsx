/**
 * To process in the sales phase (Rust only): the "E-mail not delivered" card,
 * the `reminder_due` hint and "Send N reminders" on the overdue card.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { TodoItem, TodoKind, TodoSummary } from '@/lib/api/domains/weldbooks';

const env = vi.hoisted(() => ({
  locale: 'en' as 'en' | 'nl',
  summary: undefined as unknown,
  top: {} as Record<string, unknown[]>,
  remindersOn: true,
  canUpdate: true,
  due: [] as Array<{ objectId: string; subtitle: string | null }>,
  remindBulk: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: env.locale === 'nl' ? dutch : english, language: env.locale }) };
});
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n')>()),
  getLocale: () => env.locale,
}));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canUpdate }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({}),
}));
vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({ fetchCreditPayment: vi.fn() }));
vi.mock('@/hooks/queries/use-weldbooks-sales-queries', () => ({
  isRemindersAvailable: () => env.remindersOn,
  useReminderDueItems: () => ({ data: env.due }),
  useRemindBulk: () => ({ mutate: env.remindBulk, isPending: false }),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ stack: [], open: vi.fn() }),
  useObjectPanelUrlSync: vi.fn(),
}));
vi.mock('@/components/object-panel/record-link', () => ({
  RecordLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined, currency?: string | null) => `${currency ?? '¤'} ${value}`,
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', () => ({
  TODO_TOP_LIMIT: 3,
  isTodoAvailable: () => true,
  useTodoSummary: () => ({ data: env.summary, isError: false, refetch: vi.fn() }),
  useTodoTopItems: (kind: string) => ({ data: env.top[kind] ?? [], isError: false, refetch: vi.fn() }),
  useInfiniteTodoItems: () => ({ data: { items: [], totalCount: 0 }, isError: false, refetch: vi.fn(), hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() }),
}));

import ToProcessPage from './page';

function item(kind: TodoKind, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    kind,
    objectType: 'invoice',
    objectId: 'inv_1',
    title: 'Globex',
    subtitle: 'INV-1',
    amount: '121.00',
    currency: 'EUR',
    date: '2026-11-01',
    dueDate: '2026-11-10',
    severity: 'warning',
    hint: null,
    ...overrides,
  };
}

function summary(kinds: TodoSummary['kinds']): TodoSummary {
  return { total: Object.values(kinds).reduce((sum, k) => sum + (k?.count ?? 0), 0), currency: 'EUR', kinds };
}

const card = (kind: TodoKind) => screen.getByTestId(`todo-card-${kind}`);

describe('To process, sales phase', () => {
  beforeEach(() => {
    env.locale = 'en';
    env.remindersOn = true;
    env.canUpdate = true;
    env.due = [];
    env.remindBulk.mockReset();
    env.summary = summary({
      invoices_undelivered: { count: 1, amount: '121.00', currency: 'EUR' },
      invoices_overdue: { count: 3, amount: '363.00', currency: 'EUR' },
    });
    env.top = {
      invoices_undelivered: [item('invoices_undelivered', { objectId: 'inv_9', subtitle: 'INV-9', hint: 'undelivered' })],
      invoices_overdue: [
        item('invoices_overdue', { objectId: 'inv_1', subtitle: 'INV-1', hint: 'reminder_due' }),
        item('invoices_overdue', { objectId: 'inv_2', subtitle: 'INV-2', hint: 'overdue' }),
      ],
    };
  });

  describe('E-mail not delivered', () => {
    it('lists the bounced invoice with what to do about it', () => {
      render(<ToProcessPage />);
      const undelivered = card('invoices_undelivered');
      expect(within(undelivered).getByRole('heading', { name: 'E-mail not delivered' })).toBeInTheDocument();
      expect(within(undelivered).getByText('E-mail bounced: check the address and send it again')).toBeInTheDocument();
      expect(within(undelivered).getByTestId('todo-count')).toHaveTextContent('1');
    });

    it('opens the one invoice in place, so the address can be fixed and it sent again', () => {
      render(<ToProcessPage />);
      expect(within(card('invoices_undelivered')).getByRole('link', { name: 'Open the invoice' })).toHaveAttribute(
        'href',
        '/weldbooks/invoices?stack=invoice%3Ainv_9',
      );
    });

    it('opens the list of bounced invoices when there are several', () => {
      env.summary = summary({ invoices_undelivered: { count: 4, amount: null } });
      render(<ToProcessPage />);
      expect(within(card('invoices_undelivered')).getByRole('link', { name: 'Review 4 invoices' })).toHaveAttribute(
        'href',
        '/weldbooks/invoices?show=undelivered',
      );
    });

    it('says it in Dutch', () => {
      env.locale = 'nl';
      render(<ToProcessPage />);
      const undelivered = card('invoices_undelivered');
      expect(within(undelivered).getByRole('heading', { name: nl.weldbooksConnected.todo.kinds.invoices_undelivered.title })).toBeInTheDocument();
      expect(within(undelivered).getByText('E-mail geweigerd: controleer het adres en verstuur hem opnieuw')).toBeInTheDocument();
    });
  });

  describe('Overdue invoices', () => {
    it('says in words which overdue invoice has a reminder due', () => {
      render(<ToProcessPage />);
      expect(within(card('invoices_overdue')).getByText('A reminder is due: send it')).toBeInTheDocument();
      expect(within(card('invoices_overdue')).getByText('Overdue')).toBeInTheDocument();
    });

    it('makes "Send N reminders" the primary action when some are due and manual, with the list link beside it', () => {
      env.due = [
        { objectId: 'inv_1', subtitle: 'INV-1' },
        { objectId: 'inv_3', subtitle: 'INV-3' },
      ];
      render(<ToProcessPage />);
      const overdue = card('invoices_overdue');
      expect(within(overdue).getByTestId('todo-send-reminders')).toHaveTextContent('Send 2 reminders');
      expect(within(overdue).getByRole('link', { name: en.weldbooksConnected.todo.kinds.invoices_overdue.action })).toHaveAttribute(
        'href',
        '/weldbooks/invoices?show=overdue',
      );
    });

    it('confirms, then sends them in bulk and shows who got what and who was skipped', async () => {
      const user = userEvent.setup();
      env.due = [
        { objectId: 'inv_1', subtitle: 'INV-1' },
        { objectId: 'inv_3', subtitle: 'INV-3' },
      ];
      env.remindBulk.mockImplementation((_ids: string[], options: { onSuccess: (res: unknown) => void }) =>
        options.onSuccess({
          data: {
            sent: [{ invoiceIds: ['inv_1'], level: 2, to: ['a@b.test'], messageId: 'm1' }],
            skipped: [{ invoiceId: 'inv_3', reason: 'no_recipient' }],
          },
        }),
      );
      render(<ToProcessPage />);
      await user.click(within(card('invoices_overdue')).getByTestId('todo-send-reminders'));
      const confirm = await screen.findByRole('dialog');
      expect(confirm).toHaveTextContent('Send reminders for 2 invoices?');
      expect(env.remindBulk).not.toHaveBeenCalled();
      await user.click(within(confirm).getByRole('button', { name: 'Send reminders' }));
      await waitFor(() => expect(env.remindBulk).toHaveBeenCalledWith(['inv_1', 'inv_3'], expect.any(Object)));
      const result = await screen.findByRole('dialog', { name: 'Reminders' });
      expect(within(result).getByTestId('bulk-sent')).toHaveTextContent('Reminder 2 to a@b.test for INV-1');
      expect(within(result).getByTestId('bulk-skipped')).toHaveTextContent('INV-3: has no e-mail address on the contact');
    });

    it('keeps the plain link as the primary action when no reminder is due', () => {
      render(<ToProcessPage />);
      const overdue = card('invoices_overdue');
      expect(within(overdue).queryByTestId('todo-send-reminders')).not.toBeInTheDocument();
      expect(within(overdue).getByRole('link', { name: 'View overdue invoices' })).toBeInTheDocument();
    });

    it('offers no sending where the edition has no reminders or to a member who may not update invoices', () => {
      env.due = [{ objectId: 'inv_1', subtitle: 'INV-1' }];
      env.remindersOn = false;
      const first = render(<ToProcessPage />);
      expect(screen.queryByTestId('todo-send-reminders')).not.toBeInTheDocument();
      first.unmount();

      env.remindersOn = true;
      env.canUpdate = false;
      render(<ToProcessPage />);
      expect(screen.queryByTestId('todo-send-reminders')).not.toBeInTheDocument();
    });

    it('says the reminder button in Dutch', () => {
      env.locale = 'nl';
      env.due = [{ objectId: 'inv_1', subtitle: 'INV-1' }];
      render(<ToProcessPage />);
      expect(within(card('invoices_overdue')).getByTestId('todo-send-reminders')).toHaveTextContent('1 herinnering versturen');
    });
  });
});
