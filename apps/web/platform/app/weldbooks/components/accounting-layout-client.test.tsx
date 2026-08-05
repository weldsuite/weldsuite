import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.fn();

vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

vi.mock('./weldbooks-header', () => ({
  WeldbooksHeader: () => <div data-testid="weldbooks-header">Header</div>,
}));

vi.mock('@/components/layout/module-content', () => ({
  ModuleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="module-content">{children}</div>
  ),
}));

vi.mock('@/components/page-loader', () => ({
  PageLoader: () => <div data-testid="page-loader">Loading</div>,
}));

vi.mock('@/components/accounting/entity-empty-state', () => ({
  EntityEmptyState: () => <div data-testid="entity-empty-state">Empty</div>,
}));

import { AccountingLayoutClient } from './accounting-layout-client';

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('AccountingLayoutClient', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('shows EntityEmptyState when there are no accounting entities', async () => {
    getMock.mockResolvedValue({ data: [] });

    renderWithClient(
      <AccountingLayoutClient>
        <div data-testid="page-content">Dashboard</div>
      </AccountingLayoutClient>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('entity-empty-state')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('page-content')).not.toBeInTheDocument();
    expect(screen.getByTestId('weldbooks-header')).toBeInTheDocument();
  });

  it('renders children when at least one entity exists', async () => {
    getMock.mockResolvedValue({ data: [{ id: 'ent_1' }] });

    renderWithClient(
      <AccountingLayoutClient>
        <div data-testid="page-content">Dashboard</div>
      </AccountingLayoutClient>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('page-content')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('entity-empty-state')).not.toBeInTheDocument();
  });
});
