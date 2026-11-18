import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ salesTax: true, resolved: true, tab: undefined as string | undefined }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ tab: state.tab }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { salesTax: state.salesTax }, isResolved: state.resolved, isError: false }),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en }) };
});
vi.mock('./entity-scope', () => ({ WeldbooksSettingsScope: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./dimensions/page', () => ({ default: () => <div>dimensions-page</div> }));
vi.mock('./sales-tax/page', () => ({ default: () => <div>sales-tax-page</div> }));
vi.mock('./payment-runs/page', () => ({ default: () => <div>payment-runs-page</div> }));
vi.mock('@/app/weldbooks/payment-runs/components/payment-runs-frame', () => ({
  UsOnlyGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import WeldbooksSettingsPage from './page';

describe('Settings → Apps → WeldBooks', () => {
  beforeEach(() => {
    state.salesTax = true;
    state.resolved = true;
    state.tab = undefined;
  });

  it('opens on the dimensions tab and offers the US tabs for a sales tax jurisdiction', () => {
    render(<WeldbooksSettingsPage />);
    expect(screen.getByText('dimensions-page')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /sales tax/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /payment runs/i })).toBeTruthy();
  });

  it('shows the tab named in the URL', () => {
    state.tab = 'sales-tax';
    render(<WeldbooksSettingsPage />);
    expect(screen.getByText('sales-tax-page')).toBeTruthy();
  });

  it('hides the US tabs outside sales tax jurisdictions and falls back to dimensions', () => {
    state.salesTax = false;
    state.tab = 'payment-runs';
    render(<WeldbooksSettingsPage />);
    expect(screen.getByText('dimensions-page')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /payment runs/i })).toBeNull();
  });
});
