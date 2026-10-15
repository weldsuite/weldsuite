import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BrApuracaoResult } from '@/lib/api/domains/weldbooks-br';

const env = vi.hoisted(() => ({
  apuracao: { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => void;
  },
  periods: [] as string[],
  book: vi.fn(),
  canFile: true,
  features: { spedEcd: true },
}));

vi.mock('@/hooks/queries/use-weldbooks-br-queries', () => ({
  isValidApuracaoPeriod: (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value),
  useBrApuracao: (period: string) => {
    env.periods.push(period);
    return env.apuracao;
  },
  useBookBrApuracao: () => ({ mutate: env.book, isPending: false }),
  useExportEcd: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => env.canFile }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ features: env.features }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `R$ ${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-10-12',
  }),
}));
vi.mock('@tanstack/react-router', async () => {
  const utils = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: utils.RouteLink };
});

import BrApuracaoPage, { previousMonth, shiftPeriod } from './br-apuracao-page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

const base: BrApuracaoResult = {
  period: '2026-09',
  regime: 'simples_nacional',
  simples: {
    rbt12: 300000,
    fatorR: null,
    lines: [
      { anexo: 'III', revenue: 20000, faixa: 2, nominalRate: 11.2, deduction: 9360, effectiveRate: 8.08, amount: 1616, byTax: { irpj: 100, csll: 90, iss: 400, cpp: 1026 } },
    ],
    total: 1616,
    overSublimit: false,
    overLimit: false,
    dueDate: '2026-10-20',
  },
  mei: null,
  taxes: [],
  withholdingsToPay: [{ code: 'irrf', base: 5000, amount: 75, dueDate: '2026-10-20', darfCode: '1708' }],
  withheldByCustomers: { irrf: 30, pis: 0, cofins: 0, csll: 0, inss: 0, iss: 12 },
  quarterly: null,
  informational: { cbs: 0, ibs: 0 },
  total: 1691,
  warnings: ['Revenue is close to the sublimit.'],
  status: 'open',
};

describe('BrApuracaoPage', () => {
  beforeEach(() => {
    env.apuracao = { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
    env.periods = [];
    env.book.mockReset();
    env.canFile = true;
    env.features = { spedEcd: true };
  });

  it('starts on last month and moves with the arrows', async () => {
    renderWithProviders(<BrApuracaoPage />);
    expect(env.periods.at(-1)).toBe('2026-09');
    await userEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(env.periods.at(-1)).toBe('2026-08');
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(env.periods.at(-1)).toBe('2026-10');
  });

  it('shows the DAS per annex with its split, the withholdings to pay and what customers withheld', () => {
    env.apuracao.data = base;
    renderWithProviders(<BrApuracaoPage />);
    expect(screen.getByTestId('apuracao-total')).toHaveTextContent('R$ 1691.00');
    expect(screen.getByText('Anexo III: services')).toBeInTheDocument();
    expect(screen.getByText('8.08%')).toBeInTheDocument();
    expect(screen.getByText('Split of the DAS per tax')).toBeInTheDocument();
    expect(screen.getByText('1708')).toBeInTheDocument();
    expect(within(screen.getByTestId('withheld-by-customers')).getByText('R$ 12.00')).toBeInTheDocument();
    expect(screen.getByTestId('apuracao-warnings')).toHaveTextContent('Revenue is close to the sublimit.');
  });

  it('warns when revenue is over the Simples limit', () => {
    env.apuracao.data = { ...base, simples: { ...base.simples!, overLimit: true } };
    renderWithProviders(<BrApuracaoPage />);
    expect(screen.getByTestId('simples-limit')).toHaveTextContent('over the Simples Nacional limit');
  });

  it('books the month after a confirmation, and not without permission', async () => {
    env.apuracao.data = base;
    renderWithProviders(<BrApuracaoPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Book' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book' }));
    expect(env.book).toHaveBeenCalledWith('2026-09', expect.any(Object));
  });

  it('disables booking without the permission and shows a booked month as booked', () => {
    env.canFile = false;
    env.apuracao.data = base;
    const { unmount } = renderWithProviders(<BrApuracaoPage />);
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
    unmount();

    env.apuracao.data = { ...base, status: 'booked', journalEntryId: 'je_1', taxReturnId: 'txr_1' };
    renderWithProviders(<BrApuracaoPage />);
    expect(screen.getByTestId('apuracao-status')).toHaveTextContent('Booked');
    expect(screen.getByRole('link', { name: 'View the journal entry' })).toHaveAttribute('href', '/weldbooks/journal/je_1');
  });

  it('shows the ECD export only where the jurisdiction has it', () => {
    env.apuracao.data = base;
    const { unmount } = renderWithProviders(<BrApuracaoPage />);
    expect(screen.getByRole('button', { name: 'Export SPED ECD' })).toBeInTheDocument();
    unmount();
    env.features = { spedEcd: false };
    renderWithProviders(<BrApuracaoPage />);
    expect(screen.queryByRole('button', { name: 'Export SPED ECD' })).not.toBeInTheDocument();
  });

  it('shows a load error with a retry', async () => {
    env.apuracao = { data: undefined, isLoading: false, isError: true, error: new Error('Boom'), refetch: vi.fn() };
    renderWithProviders(<BrApuracaoPage />);
    expect(screen.getByTestId('apuracao-load-error')).toHaveTextContent('Boom');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(env.apuracao.refetch).toHaveBeenCalled();
  });
});

describe('period helpers', () => {
  it('shifts across year ends', () => {
    expect(shiftPeriod('2026-01', -1)).toBe('2025-12');
    expect(shiftPeriod('2026-12', 1)).toBe('2027-01');
    expect(previousMonth('2026-03-15')).toBe('2026-02');
  });
});
