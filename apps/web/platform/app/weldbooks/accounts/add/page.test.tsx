import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaxLineCatalog } from '@/lib/api/domains/weldbooks';

const mocks = vi.hoisted(() => ({
  jurisdiction: { code: 'US' as string | null, form1099: true },
  createAccount: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateAccount: () => ({ mutateAsync: mocks.createAccount, isPending: false }),
  useTaxLineCatalog: () => ({ data: catalog, isLoading: false, isError: false }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ entityCurrency: 'USD' }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({
    code: mocks.jurisdiction.code,
    features: { form1099: mocks.jurisdiction.form1099 },
  }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import AddAccountPage from './page';

const catalog: TaxLineCatalog = {
  form: 'sch_c',
  formLabel: 'Schedule C (Form 1040)',
  taxYear: 2026,
  sections: [
    { key: 'income', label: 'Income' },
    { key: 'deduction', label: 'Deductions' },
  ],
  lines: [
    { code: 'sch_c.1', form: 'sch_c', line: '1', label: 'Gross receipts or sales', section: 'income' },
    { code: 'sch_c.8', form: 'sch_c', line: '8', label: 'Advertising', section: 'deduction' },
  ],
};

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Code/), '6100');
  await user.type(screen.getByLabelText(/^Name/), 'Advertising');
}

describe('AddAccountPage tax reporting', () => {
  beforeEach(() => {
    mocks.jurisdiction.code = 'US';
    mocks.jurisdiction.form1099 = true;
    mocks.createAccount.mockReset().mockResolvedValue({ data: { id: 'acc_new' } });
    mocks.navigate.mockReset();
  });

  it('asks a US entity for the tax line and the 1099 box', async () => {
    const user = userEvent.setup();
    render(<AddAccountPage />);

    expect(screen.getByText('Tax reporting')).toBeInTheDocument();
    expect(screen.getByText('The line of Schedule C (Form 1040) this account reports on.')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Tax line' }));
    const groups = await screen.findAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby')).filter(Boolean)).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'No tax line' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '8 · Advertising' }));

    await user.click(screen.getByRole('combobox', { name: '1099 box' }));
    expect(screen.getByRole('option', { name: 'Omit (never reported on a 1099)' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '1099-NEC (1): Nonemployee compensation' }));

    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: /Create Account/i }));

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledTimes(1));
    expect(mocks.createAccount.mock.calls[0][0]).toMatchObject({
      code: '6100',
      name: 'Advertising',
      taxLine: 'sch_c.8',
      form1099Box: 'nec_1',
    });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/weldbooks/accounts' });
  });

  it('sends null for a tax line and a 1099 box left empty', async () => {
    const user = userEvent.setup();
    render(<AddAccountPage />);
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: /Create Account/i }));

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledTimes(1));
    expect(mocks.createAccount.mock.calls[0][0]).toMatchObject({ taxLine: null, form1099Box: null });
  });

  it('leaves out the 1099 box where the jurisdiction files no 1099s', async () => {
    mocks.jurisdiction.form1099 = false;
    const user = userEvent.setup();
    render(<AddAccountPage />);
    expect(screen.queryByRole('combobox', { name: '1099 box' })).not.toBeInTheDocument();
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: /Create Account/i }));

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledTimes(1));
    const payload = mocks.createAccount.mock.calls[0][0];
    expect(payload.taxLine).toBeNull();
    expect(payload.form1099Box).toBeUndefined();
  });

  it('shows nothing about tax lines for another jurisdiction and never sends them', async () => {
    mocks.jurisdiction.code = 'NL';
    mocks.jurisdiction.form1099 = false;
    const user = userEvent.setup();
    render(<AddAccountPage />);

    expect(screen.queryByText('Tax reporting')).not.toBeInTheDocument();
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: /Create Account/i }));

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledTimes(1));
    const payload = mocks.createAccount.mock.calls[0][0];
    expect(payload).not.toHaveProperty('taxLine');
    expect(payload).not.toHaveProperty('form1099Box');
  });
});
