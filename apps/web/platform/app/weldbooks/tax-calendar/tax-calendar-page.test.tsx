import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaxCalendar, TaxDeadline } from '@/lib/api/domains/weldbooks-assets';

const completeAsync = vi.fn();
const reopenAsync = vi.fn();
const permissions = new Set(['taxes:read', 'taxes:update']);
let jurisdiction = 'US';
let calendar: TaxCalendar | undefined;

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value.slice(0, 10),
    today: () => '2026-03-10',
    dateLocale: 'en-US',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  useTaxCalendar: () => ({ data: calendar, isLoading: false, isError: false, refetch: vi.fn() }),
  useCompleteDeadline: () => ({ mutateAsync: completeAsync, isPending: false }),
  useReopenDeadline: () => ({ mutateAsync: reopenAsync, isPending: false }),
}));

import TaxCalendarPage from './page';
import { renderWithProviders } from '../fixed-assets/test-utils';

const deadline = (key: string, dueDate: string, extra: Partial<TaxDeadline> = {}): TaxDeadline => ({
  key,
  kind: 'income_tax_return',
  title: `Deadline ${key}`,
  dueDate,
  nominalDate: dueDate,
  form: 'f1120s',
  completed: false,
  completedAt: null,
  completedBy: null,
  completionNotes: null,
  completionSource: null,
  returnId: null,
  returnStatus: null,
  daysUntilDue: 0,
  overdue: false,
  ...extra,
});

const statusOf = (key: string) => within(screen.getByTestId(`deadline-${key}`)).getByTestId('deadline-status');

describe('Tax calendar page', () => {
  beforeEach(() => {
    completeAsync.mockReset().mockResolvedValue({});
    reopenAsync.mockReset().mockResolvedValue(undefined);
    permissions.clear();
    permissions.add('taxes:read');
    permissions.add('taxes:update');
    jurisdiction = 'US';
    calendar = {
      supported: true,
      year: 2026,
      today: '2026-03-10',
      form: 'f1120s',
      facts: { hasPayroll: true, files1099: true, hasBackupWithholding: false, agencies: 1 },
      items: [
        deadline('late', '2026-01-31', { title: 'Form 1099-NEC to the IRS', kind: 'information_return', form: '1099_nec' }),
        deadline('soon', '2026-03-16', { title: 'Form 1120-S due', nominalDate: '2026-03-15', extensionForm: '7004' }),
        deadline('later', '2026-09-15', { title: 'Extended return', kind: 'income_tax_extended_return' }),
        deadline('filed', '2026-02-20', {
          title: 'Sales tax, January',
          kind: 'sales_tax',
          form: 'sales_tax',
          completed: true,
          completedAt: '2026-02-18T10:00:00.000Z',
          completionSource: 'return',
        }),
        deadline('ticked', '2026-02-10', { completed: true, completedAt: '2026-02-09T10:00:00.000Z', completionSource: 'manual', completionNotes: 'Confirmation 42' }),
        deadline('941', '2026-04-30', { kind: 'payroll', form: '941', informational: true, title: 'Form 941, Q1' }),
      ],
    };
  });

  it('shows each deadline with the chip its date and state give', () => {
    renderWithProviders(<TaxCalendarPage />);

    expect(statusOf('late')).toHaveAttribute('data-status', 'overdue');
    expect(statusOf('late')).toHaveTextContent('Overdue');
    expect(statusOf('soon')).toHaveAttribute('data-status', 'dueSoon');
    expect(statusOf('later')).toHaveAttribute('data-status', 'upcoming');
    expect(statusOf('filed')).toHaveAttribute('data-status', 'done');
    expect(statusOf('ticked')).toHaveAttribute('data-status', 'done');
    expect(statusOf('941')).toHaveAttribute('data-status', 'informational');
  });

  it('counts overdue, due soon, upcoming and done at the top', () => {
    renderWithProviders(<TaxCalendarPage />);
    const counts = screen.getByTestId('calendar-counts');
    expect(counts).toHaveTextContent('1 overdue');
    expect(counts).toHaveTextContent('1 due soon');
    expect(counts).toHaveTextContent('1 upcoming');
    expect(counts).toHaveTextContent('2 done');
  });

  it('groups the year by month, earliest first', () => {
    renderWithProviders(<TaxCalendarPage />);
    const months = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(months).toEqual(['January 2026', 'February 2026', 'March 2026', 'April 2026', 'September 2026']);
  });

  it('says how late or how soon a deadline is, and when one was moved or extended', () => {
    renderWithProviders(<TaxCalendarPage />);
    expect(screen.getByTestId('deadline-late')).toHaveTextContent('38 days overdue');
    expect(screen.getByTestId('deadline-soon')).toHaveTextContent('in 6 days');
    expect(screen.getByTestId('deadline-soon')).toHaveTextContent('moved from 2026-03-15');
    expect(screen.getByTestId('deadline-soon')).toHaveTextContent('extended with Form 7004');
  });

  it('links sales tax deadlines and 1099s to their screens', () => {
    renderWithProviders(<TaxCalendarPage />);
    expect(within(screen.getByTestId('deadline-filed')).getByRole('link', { name: /Sales tax returns/ })).toHaveAttribute('href', '/weldbooks/sales-tax/returns');
    expect(within(screen.getByTestId('deadline-late')).getByRole('link', { name: /1099 forms/ })).toHaveAttribute('href', '/weldbooks/form-1099');
    expect(within(screen.getByTestId('deadline-later')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('marks a deadline done with a note', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxCalendarPage />);

    await user.click(within(screen.getByTestId('deadline-soon')).getByTestId('deadline-mark-done'));
    await user.type(await screen.findByLabelText('Notes'), 'Filed online');
    await user.click(screen.getByTestId('deadline-confirm'));

    await waitFor(() => expect(completeAsync).toHaveBeenCalledTimes(1));
    expect(completeAsync).toHaveBeenCalledWith({ deadlineKey: 'soon', dueDate: '2026-03-16', notes: 'Filed online' });
  });

  it('marks a deadline done without a note', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxCalendarPage />);

    await user.click(within(screen.getByTestId('deadline-later')).getByTestId('deadline-mark-done'));
    await user.click(await screen.findByTestId('deadline-confirm'));

    await waitFor(() => expect(completeAsync).toHaveBeenCalledWith({ deadlineKey: 'later', dueDate: '2026-09-15' }));
  });

  it('keeps the dialog open and shows the error when marking fails', async () => {
    completeAsync.mockRejectedValueOnce(new Error('Failed to mark the deadline done'));
    const user = userEvent.setup();
    renderWithProviders(<TaxCalendarPage />);

    await user.click(within(screen.getByTestId('deadline-soon')).getByTestId('deadline-mark-done'));
    await user.click(await screen.findByTestId('deadline-confirm'));
    expect(await screen.findByText('Failed to mark the deadline done')).toBeInTheDocument();
  });

  it('undoes a manual mark, and offers no undo for a deadline done by a filed return', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaxCalendarPage />);

    expect(within(screen.getByTestId('deadline-filed')).queryByTestId('deadline-undo')).not.toBeInTheDocument();
    expect(screen.getByTestId('deadline-filed')).toHaveTextContent('Done because the return was filed.');
    expect(screen.getByTestId('deadline-ticked')).toHaveTextContent('Confirmation 42');

    await user.click(within(screen.getByTestId('deadline-ticked')).getByTestId('deadline-undo'));
    await waitFor(() => expect(reopenAsync).toHaveBeenCalledWith('ticked'));
  });

  it('hides marking and undoing without taxes:update', () => {
    permissions.delete('taxes:update');
    renderWithProviders(<TaxCalendarPage />);
    expect(screen.queryByTestId('deadline-mark-done')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deadline-undo')).not.toBeInTheDocument();
  });

  it('says so for an entity outside the US', () => {
    jurisdiction = 'NL';
    renderWithProviders(<TaxCalendarPage />);
    expect(screen.getByText('This screen is for US accounting entities only.')).toBeInTheDocument();
    expect(screen.queryByTestId('tax-calendar-agenda')).not.toBeInTheDocument();
  });
});
