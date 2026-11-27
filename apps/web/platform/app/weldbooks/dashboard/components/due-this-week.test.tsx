import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { Dashboard } from '@/lib/api/domains/weldbooks';

const env = vi.hoisted(() => ({
  todoAvailable: false,
  locale: 'en' as 'en' | 'nl',
  bills: [] as Array<Record<string, unknown>>,
  listFilters: undefined as unknown,
  listEnabled: undefined as boolean | undefined,
  todoEnabled: undefined as boolean | undefined,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: env.locale === 'nl' ? dutch : english, language: env.locale }) };
});
vi.mock('@/components/object-panel', () => ({ useObjectPanel: () => ({ open: vi.fn() }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatMoney: (value: number | string) => `$${value}`,
    today: () => '2026-11-27',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', () => ({
  isTodoAvailable: () => env.todoAvailable,
  useTodoTopItems: (_kind: string, _limit: number, options: { enabled?: boolean }) => {
    env.todoEnabled = options.enabled;
    return { data: undefined };
  },
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useInfiniteAccountingBills: (filters: unknown, options: { enabled?: boolean }) => {
    env.listFilters = filters;
    env.listEnabled = options.enabled;
    return { data: { rows: env.bills } };
  },
}));

import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';
import { DueThisWeek, dueThisWeek, type DueRow } from './due-this-week';

const row = (id: string, dueDate: string, kind: DueRow['kind'] = 'invoice'): DueRow => ({
  kind,
  id,
  number: id,
  contactName: null,
  dueDate,
  amount: '1',
  currency: 'EUR',
});

describe('dueThisWeek', () => {
  const today = '2026-11-27';

  it('keeps what is due by the end of the week, soonest first, invoices and bills together', () => {
    const rows = dueThisWeek(
      [row('inv-late', '2026-12-04'), row('bill-soon', '2026-11-28', 'bill'), row('inv-far', '2026-12-05'), row('bill-overdue', '2026-11-02', 'bill')],
      today,
    );
    expect(rows.map((r) => r.id)).toEqual(['bill-overdue', 'bill-soon', 'inv-late']);
  });

  it('compares the day, whatever time the date carries', () => {
    expect(dueThisWeek([row('a', '2026-12-04T23:00:00.000Z')], today)).toHaveLength(1);
  });

  it('shows at most ten rows', () => {
    const many = Array.from({ length: 14 }, (_, i) => row(`r${i}`, '2026-11-28'));
    expect(dueThisWeek(many, today)).toHaveLength(10);
  });
});

describe('DueThisWeek where the edition has no to-process list (Global)', () => {
  beforeEach(() => {
    env.todoAvailable = false;
    env.locale = 'en';
    env.bills = [];
  });

  const dashboard = { upcomingDue: [], currency: 'EUR' } as unknown as Dashboard;

  it('narrows the first page of approved bills to the week instead', () => {
    env.bills = [
      { id: 'b1', billNumber: 'SOON', status: 'approved', dueDate: '2026-11-30', total: '10', balanceDue: '10', currency: 'EUR', contactName: 'Dell' },
      { id: 'b2', billNumber: 'LATER', status: 'approved', dueDate: '2027-01-30', total: '10', balanceDue: '10', currency: 'EUR', contactName: 'Dell' },
    ];
    renderWithProviders(<DueThisWeek dashboard={dashboard} />);
    expect(env.listFilters).toEqual({ status: 'approved' });
    expect(env.listEnabled).toBe(true);
    expect(env.todoEnabled).toBe(false);
    expect(screen.getByText('SOON')).toBeInTheDocument();
    expect(screen.queryByText('LATER')).not.toBeInTheDocument();
  });

  it('says so when nothing falls due, in English and in Dutch', () => {
    renderWithProviders(<DueThisWeek dashboard={dashboard} />);
    expect(screen.getByText('Nothing falls due this week.')).toBeInTheDocument();
    env.locale = 'nl';
    renderWithProviders(<DueThisWeek dashboard={dashboard} />);
    expect(screen.getByText(nl.accounting.dashboard.noDueThisWeek)).toBeInTheDocument();
  });

  it('does not read the approved-bills list where the to-process list serves the bills', () => {
    env.todoAvailable = true;
    renderWithProviders(<DueThisWeek dashboard={dashboard} />);
    expect(env.listEnabled).toBe(false);
    expect(env.todoEnabled).toBe(true);
  });
});
