import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.fn();

vi.mock('@/lib/api/weldbooks-client', () => ({
  weldbooksApi: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

vi.mock('@/contexts/workspace-context', () => ({
  useWorkspaceId: () => 'ws_test',
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      accounting: {
        layout: {
          loadError: 'Failed to load accounting entities. Please try again.',
          retry: 'Retry',
        },
      },
    },
  }),
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
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
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

  it('shows retryable error UI instead of empty state when the entities request fails', async () => {
    getMock.mockRejectedValue(new Error('network down'));

    renderWithClient(
      <AccountingLayoutClient>
        <div data-testid="page-content">Dashboard</div>
      </AccountingLayoutClient>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('weldbooks-entities-load-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to load accounting entities/i)).toBeInTheDocument();
    expect(screen.queryByTestId('entity-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('page-content')).not.toBeInTheDocument();

    getMock.mockResolvedValue({ data: [{ id: 'ent_1' }] });
    await userEvent.click(screen.getByRole('button', { name: /Retry/i }));

    await waitFor(() => {
      expect(screen.getByTestId('page-content')).toBeInTheDocument();
    });
  });

  it('keeps cached content when a background refetch fails', async () => {
    getMock.mockResolvedValueOnce({ data: [{ id: 'ent_1' }] });

    const { client } = renderWithClient(
      <AccountingLayoutClient>
        <div data-testid="page-content">Dashboard</div>
      </AccountingLayoutClient>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('page-content')).toBeInTheDocument();
    });

    getMock.mockRejectedValueOnce(new Error('refetch failed'));
    await client.refetchQueries({ queryKey: ['accounting', 'entities'] });

    await waitFor(() => {
      expect(getMock).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('page-content')).toBeInTheDocument();
    expect(screen.queryByTestId('weldbooks-entities-load-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-empty-state')).not.toBeInTheDocument();
  });
});
