import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  allowed: new Set<string>(['orders:create', 'commerce_settings:read']),
  settings: { data: { data: { defaultCurrency: 'PLN' } }, isLoading: false } as { data?: { data: { defaultCurrency: string } }; isLoading: boolean },
  push: vi.fn(),
  settingsEnabled: [] as boolean[],
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => env.allowed.has(permission) }),
}));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: env.push }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useCommerceSettings: (enabled: boolean) => {
    env.settingsEnabled.push(enabled);
    return env.settings;
  },
}));
vi.mock('../components/order-form', () => ({
  OrderForm: ({ defaultCurrency, onSaved, onCancel }: { defaultCurrency: string; onSaved: (id: string) => void; onCancel: () => void }) => (
    <div>
      <p data-testid="currency">{defaultCurrency}</p>
      <button type="button" onClick={() => onSaved('ord_9')}>
        saved
      </button>
      <button type="button" onClick={onCancel}>
        cancel
      </button>
    </div>
  ),
}));

import NewCommerceOrderPage from './page';

beforeEach(() => {
  env.allowed = new Set(['orders:create', 'commerce_settings:read']);
  env.settings = { data: { data: { defaultCurrency: 'PLN' } }, isLoading: false };
  env.push.mockReset();
  env.settingsEnabled = [];
});

describe('NewCommerceOrderPage', () => {
  it('starts the order in the workspace default currency, under a link back to the orders', () => {
    render(<NewCommerceOrderPage />);
    expect(screen.getByRole('heading', { name: 'New order' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to orders/ }).getAttribute('href')).toBe('/weldcommerce/orders');
    expect(screen.getByTestId('currency').textContent).toBe('PLN');
  });

  it('opens the new order panel on the list once it is created, and goes back when cancelled', async () => {
    const user = userEvent.setup();
    render(<NewCommerceOrderPage />);
    await user.click(screen.getByRole('button', { name: 'saved' }));
    expect(env.push).toHaveBeenCalledWith('/weldcommerce/orders?stack=order:ord_9');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(env.push).toHaveBeenLastCalledWith('/weldcommerce/orders');
  });

  it('waits for the settings, so the currency is right from the first render', () => {
    env.settings = { isLoading: true };
    render(<NewCommerceOrderPage />);
    expect(screen.queryByTestId('currency')).toBeNull();
  });

  it('uses EUR when the member may not read the settings, and does not ask for them', () => {
    env.allowed = new Set(['orders:create']);
    env.settings = { isLoading: false };
    render(<NewCommerceOrderPage />);
    expect(screen.getByTestId('currency').textContent).toBe('EUR');
    expect(env.settingsEnabled.every((enabled) => enabled === false)).toBe(true);
  });

  it('says so to a member who may not create orders, without showing the form', () => {
    env.allowed = new Set();
    render(<NewCommerceOrderPage />);
    expect(screen.getByText('You are not allowed to create orders.')).toBeTruthy();
    expect(screen.queryByTestId('currency')).toBeNull();
  });
});
