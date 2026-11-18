import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Account } from '@/lib/api/domains/weldbooks';

const mocks = vi.hoisted(() => ({
  account: null as Account | null,
  updateAccount: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mocks.toastError(...args), success: vi.fn() } }));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'acc_1' }),
  useNavigate: () => mocks.navigate,
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccount: () => ({ data: mocks.account ? { data: mocks.account } : undefined, isLoading: false }),
  useUpdateAccount: () => ({ mutateAsync: mocks.updateAccount, isPending: false }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ entityCurrency: 'EUR' }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: 'NL', features: { form1099: false } }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import EditAccountPage from './page';

const stored = (overrides: Partial<Account> = {}): Account =>
  ({
    id: 'acc_1',
    entityId: 'ent_1',
    code: '4699',
    name: 'E2E costs',
    description: null,
    type: 'expense',
    subtype: null,
    parentAccountId: null,
    currency: 'EUR',
    isActive: true,
    isSystemAccount: false,
    openingBalance: '0.00',
    currentBalance: '0.00',
    normalSide: 'debit',
    ...overrides,
  }) as Account;

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

describe('EditAccountPage', () => {
  beforeEach(() => {
    mocks.account = stored();
    mocks.updateAccount.mockReset().mockResolvedValue({ data: { id: 'acc_1' } });
    mocks.navigate.mockReset();
    mocks.toastError.mockReset();
  });

  it('opens with the stored type and normal side', () => {
    render(<EditAccountPage />);
    expect(screen.getByLabelText(/^Type/)).toHaveTextContent('Expense');
    expect(screen.getByLabelText(/^Normal side/)).toHaveTextContent('Debit');
  });

  it('saves a new name, with the opening balance as a decimal string', async () => {
    const user = userEvent.setup();
    render(<EditAccountPage />);
    const name = screen.getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Test costs');
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledTimes(1));
    const { id, data } = mocks.updateAccount.mock.calls[0][0];
    expect(id).toBe('acc_1');
    expect(data).toMatchObject({ name: 'Test costs', openingBalance: '0.00', isActive: true });
    // Unchanged code, type and normal side stay out: a system account refuses them.
    expect(data).not.toHaveProperty('code');
    expect(data).not.toHaveProperty('type');
    expect(data).not.toHaveProperty('normalSide');
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/weldbooks/accounts/$id', params: { id: 'acc_1' } });
  });

  it('says why when the form is refused', async () => {
    const user = userEvent.setup();
    render(<EditAccountPage />);
    await user.clear(screen.getByLabelText(/^Name/));
    await user.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('The account could not be saved', {
        description: 'sweep.weldbooks.accountForm.checkFields',
      }),
    );
    expect(screen.getByText('sweep.weldbooks.accountForm.nameRequired')).toBeInTheDocument();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
  });
});
