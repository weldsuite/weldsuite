/**
 * TASK-1083: the open deal panel kept showing the old name after a rename even
 * though the API (and the kanban card) already had the new one.
 *
 * The panel reads the deal from the `useOpportunity` query and an edit used to
 * reach it only through a refetch. These tests drive the real hooks and the
 * Details tab against a server whose requests we release by hand, so we can
 * put a stale read in the way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));
vi.mock('@/components/team/member-select', () => ({ MemberSelect: () => null }));
vi.mock('@weldsuite/realtime/react', () => ({ useTopic: () => undefined }));
vi.mock('@/hooks/queries/use-pipelines-queries', () => ({
  usePipelines: () => ({ data: { data: [{ id: 'pl_sales', name: 'Sales pipeline' }] } }),
  usePipelineStages: () => ({
    data: { data: [{ id: 'pls_1', name: 'Stage 1', position: 0, pipeline: 'pl_sales' }] },
  }),
}));

interface PendingRequest {
  /** The server answers: a GET with the row as it was when the request arrived. */
  release: () => void;
  /** PATCH only: the server applies the change (its commit). */
  commit?: () => void;
  fail?: () => void;
}

const server = {
  row: {} as Record<string, unknown>,
  gets: [] as PendingRequest[],
  patches: [] as (PendingRequest & { body: Record<string, unknown> })[],
};

function resetServer() {
  server.row = {
    id: 'opp_1',
    name: 'QA Verify deal B',
    amount: '5300',
    currency: 'USD',
    stage: 'pls_1',
    stageId: 'pls_1',
    status: 'open',
    pipeline: 'pl_sales',
    customerId: 'cust_1',
    probability: 10,
  };
  server.gets = [];
  server.patches = [];
}

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({
    getClient: async () => ({
      get: (path: string) =>
        new Promise((resolve) => {
          if (!path.startsWith('/opportunities/')) return resolve({ data: [] });
          const snapshot = { ...server.row };
          server.gets.push({ release: () => resolve({ data: snapshot }) });
        }),
      patch: (_path: string, body: Record<string, unknown>) =>
        new Promise((resolve, reject) => {
          server.patches.push({
            body,
            commit: () => Object.assign(server.row, body),
            release: () => resolve({ data: { id: 'opp_1' } }),
            fail: () => reject(new Error('boom')),
          });
        }),
    }),
  }),
}));

import { OpportunityDetailsTab } from './opportunity-panel';
import { opportunityKeys } from '@/hooks/queries/use-opportunities-queries';
import { useOpportunity, useUpdateOpportunity, type Opportunity } from './use-opportunity-data';

/** The panel's wiring: header title + Details tab fed from `useOpportunity`. */
function PanelHarness() {
  const query = useOpportunity('opp_1');
  const update = useUpdateOpportunity();
  const opportunity = query.data?.data as Opportunity | undefined;
  if (!opportunity) return null;
  return (
    <div>
      <h1 data-testid="title">{opportunity.name}</h1>
      <OpportunityDetailsTab
        opportunity={opportunity}
        onUpdateField={(patch) => {
          update.mutateAsync({ id: opportunity.id, data: patch }).catch(() => undefined);
        }}
      />
    </div>
  );
}

async function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PanelHarness />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(server.gets).toHaveLength(1));
  server.gets[0]!.release();
  await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B'));
  return { queryClient, user: userEvent.setup() };
}

type User = ReturnType<typeof userEvent.setup>;

async function rename(user: User, name: string) {
  await user.click(screen.getByRole('button', { name: 'sweep.entities.fieldName' }));
  await user.keyboard(`{Control>}a{/Control}${name}{Enter}`);
}

async function setAmount(user: User, amount: string) {
  await user.click(screen.getByRole('button', { name: 'sweep.entities.fieldAmount' }));
  await user.keyboard(`{Control>}a{/Control}${amount}{Enter}`);
}

describe('deal panel after an edit (TASK-1083)', () => {
  beforeEach(resetServer);

  it('shows the new name in the header and the Name row before the server has answered', async () => {
    const { user } = await renderPanel();

    await rename(user, 'QA Verify deal B v2');

    // The PATCH is still in flight, nothing has been refetched.
    expect(server.patches).toHaveLength(1);
    expect(server.patches[0]!.body).toEqual({ name: 'QA Verify deal B v2' });
    expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B v2');
    // Header + the Name row: two places show it.
    expect(screen.getAllByText('QA Verify deal B v2')).toHaveLength(2);
    expect(screen.queryByText('QA Verify deal B')).not.toBeInTheDocument();
  });

  it('keeps the new name when the server then confirms it and the deal is refetched', async () => {
    const { user } = await renderPanel();

    await rename(user, 'QA Verify deal B v2');
    server.patches[0]!.commit!();
    server.patches[0]!.release();

    await waitFor(() => expect(server.gets).toHaveLength(2));
    server.gets[1]!.release();
    await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B v2'));
  });

  it('is not overwritten by a read that was already in flight when the edit was made', async () => {
    const { user, queryClient } = await renderPanel();

    // e.g. a realtime event or another view refetching: this GET snapshots the OLD row.
    void queryClient.invalidateQueries({ queryKey: opportunityKeys.all });
    await waitFor(() => expect(server.gets).toHaveLength(2));

    await rename(user, 'QA Verify deal B v2');
    // The stale response lands after the edit.
    server.gets[1]!.release();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B v2');
  });

  it('never shows a half-updated deal when the amount edit is answered before the rename', async () => {
    const { user } = await renderPanel();

    await rename(user, 'QA Verify deal B v2');
    await setAmount(user, '6100');
    expect(server.patches).toHaveLength(2);
    const [renamePatch, amountPatch] = server.patches as [
      (typeof server.patches)[number],
      (typeof server.patches)[number],
    ];

    // The faster PATCH (amount) finishes first, while the rename is not committed yet.
    amountPatch.commit!();
    amountPatch.release();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Refetching now would read {old name, new amount} and show exactly that.
    expect(server.gets).toHaveLength(1);
    expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B v2');

    renamePatch.commit!();
    renamePatch.release();
    await waitFor(() => expect(server.gets).toHaveLength(2));
    server.gets[1]!.release();

    await waitFor(() => {
      expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B v2');
      expect(screen.getByText(/6.?100/)).toBeInTheDocument();
    });
  });

  it('puts the server value back when the edit is rejected', async () => {
    const { user } = await renderPanel();

    await rename(user, 'Rejected name');
    expect(screen.getByTestId('title')).toHaveTextContent('Rejected name');

    server.patches[0]!.fail!();
    await waitFor(() => expect(server.gets).toHaveLength(2));
    server.gets[1]!.release();

    await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('QA Verify deal B'));
    expect(screen.getByTestId('title')).not.toHaveTextContent('Rejected name');
  });
});
