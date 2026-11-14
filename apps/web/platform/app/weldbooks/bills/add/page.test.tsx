import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  getRouteApi: () => ({ useSearch: () => ({}) }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('sonner', () => ({ toast: { success: env.toastSuccess, error: env.toastError } }));
vi.mock('@/hooks/use-current-entity-currency', () => ({ useCurrentEntityCurrency: () => ({ entityCurrency: 'EUR' }) }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateBill: () => ({ mutate: env.create, isPending: false }),
}));
// The form has its own tests: here it only hands over a payload.
vi.mock('../components/bill-form', () => ({
  BillForm: ({ onSubmit }: { onSubmit: (payload: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => onSubmit({ contactId: 'sup_1', items: [] })}>
      submit-bill
    </button>
  ),
}));

import AddBillPage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

describe('AddBillPage', () => {
  beforeEach(() => {
    env.push.mockReset();
    env.create.mockReset();
    env.toastSuccess.mockReset();
    env.toastError.mockReset();
  });

  it('has a back arrow that is one link, and a title', () => {
    renderWithProviders(<AddBillPage />);
    const back = screen.getByRole('link', { name: 'Back to bills' });
    expect(back).toHaveAttribute('href', '/weldbooks/bills');
    expect(back.querySelector('button')).toBeNull();
    expect(screen.getByRole('heading', { name: 'New bill' })).toBeInTheDocument();
  });

  it('opens the new bill in its side panel on the bills list, with a toast', async () => {
    env.create.mockImplementation((_payload, options: { onSuccess: (res: unknown) => void }) =>
      options.onSuccess({ data: { id: 'bill_new' } }),
    );
    const user = userEvent.setup();
    renderWithProviders(<AddBillPage />);

    await user.click(screen.getByRole('button', { name: 'submit-bill' }));

    await waitFor(() => expect(env.push).toHaveBeenCalledWith('/weldbooks/bills?stack=bill:bill_new'));
    expect(env.toastSuccess).toHaveBeenCalledWith('Bill created');
  });

  it('stays on the page and says why when the bill cannot be saved', async () => {
    env.create.mockImplementation((_payload, options: { onError: (err: unknown) => void }) =>
      options.onError(new Error('Period is locked')),
    );
    const user = userEvent.setup();
    renderWithProviders(<AddBillPage />);

    await user.click(screen.getByRole('button', { name: 'submit-bill' }));

    await waitFor(() => expect(env.toastError).toHaveBeenCalledWith('Failed to save bill', { description: 'Period is locked' }));
    expect(env.push).not.toHaveBeenCalled();
  });
});
