import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
// The form has its own tests: here it only reports a save.
vi.mock('../components/recurring-invoice-form', () => ({
  RecurringInvoiceForm: ({ onSaved }: { onSaved: (id: string) => void }) => (
    <button type="button" onClick={() => onSaved('ri_new')}>
      save-template
    </button>
  ),
}));

import AddRecurringInvoicePage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

describe('AddRecurringInvoicePage', () => {
  beforeEach(() => env.push.mockReset());

  it('has a back arrow link and one heading', () => {
    renderWithProviders(<AddRecurringInvoicePage />);
    expect(screen.getByRole('link', { name: 'Back to recurring invoices' })).toHaveAttribute('href', '/weldbooks/recurring');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('opens the saved template in its side panel on the list, not full screen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AddRecurringInvoicePage />);
    await user.click(screen.getByRole('button', { name: 'save-template' }));
    expect(env.push).toHaveBeenCalledWith('/weldbooks/recurring?stack=recurring_invoice:ri_new');
  });
});
