/**
 * The Service request section of the details panel: what a request shows
 * (item, state, steps with approvers, decisions and comments), who gets
 * Approve / Reject and what they send, and making a conversation a request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import type { DeskWorkspaceMember } from '@/hooks/queries/use-desk-workspace-members';

interface Callbacks {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
}

const state = vi.hoisted(() => ({
  request: undefined as unknown,
  loading: false,
  items: [] as unknown[],
  perms: new Set<string>(),
  userId: 'user_me',
  decide: vi.fn<(input: { conversationId: string; decision: string; comment?: string }, callbacks: Callbacks) => void>(),
  attach: vi.fn<(input: { conversationId: string; catalogItemId: string }, callbacks: Callbacks) => void>(),
  createTasks: vi.fn<(conversationId: string, callbacks: Callbacks) => void>(),
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/auth', () => ({ useUser: () => ({ user: { id: state.userId } }) }));
vi.mock('@weldsuite/ui/components/lucide-dynamic-icon', () => ({ LucideDynamicIcon: () => null }));
vi.mock('@/hooks/queries/use-desk-catalog-queries', () => ({
  deskCatalogErrorMessage: () => null,
  deskCatalogRefusal: (err: { reason?: string }) => err.reason ?? null,
  useDeskConversationRequest: () => ({ data: state.request, isLoading: state.loading, isError: false }),
  useDeskCatalogItems: () => ({ data: state.items, isLoading: false, isError: false }),
  useDecideDeskApproval: () => ({ mutate: state.decide, isPending: false }),
  useAttachDeskCatalogItem: () => ({ mutate: state.attach, isPending: false }),
  useCreateDeskRequestTasks: () => ({ mutate: state.createTasks, isPending: false }),
}));

import { ServiceRequestSection } from './service-request-section';

const conversation = { id: 'dconv_1', state: 'open', mergedIntoId: null } as unknown as DeskConversation;
const members = [
  { id: 'user_me', userId: 'user_me', name: 'Me Myself' },
  { id: 'user_alice', userId: 'user_alice', name: 'Alice' },
] as DeskWorkspaceMember[];

const step = (index: number, extra: Record<string, unknown> = {}) => ({
  id: `dappr_${index}`,
  stepIndex: index,
  stepName: `Step name ${index}`,
  approverId: 'user_alice',
  status: 'waiting',
  decidedAt: null,
  decidedById: null,
  comment: null,
  ...extra,
});

const request = (approvals: unknown[], approvalStatus: string | null = 'pending') => ({
  item: { id: 'dcat_1', name: 'Laptop', category: 'Hardware', icon: null, deliveryEstimate: '3 days', fulfilmentTaskCount: 2 },
  approvalStatus,
  approvals,
  fulfilmentStarted: true,
});

const renderSection = (value: Partial<DeskConversation> = {}) =>
  render(<ServiceRequestSection conversation={{ ...conversation, ...value } as DeskConversation} members={members} />);

beforeEach(() => {
  state.request = null;
  state.loading = false;
  state.items = [];
  state.perms = new Set();
  state.userId = 'user_me';
  state.decide.mockReset();
  state.attach.mockReset();
  state.createTasks.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => cleanup());

describe('a service request', () => {
  it('shows the item, the state and every step with its approver, decision and comment', () => {
    state.request = request(
      [
        step(0, { status: 'approved', decidedAt: '2026-01-01T10:00:00.000Z', decidedById: 'user_alice', comment: 'Within budget' }),
        step(1, { approverId: 'user_me', status: 'pending' }),
        step(2, { approverId: null, status: 'waiting', stepName: null }),
      ],
      'pending',
    );
    renderSection();
    expect(screen.getByText('Laptop')).toBeInTheDocument();
    expect(screen.getByText('Delivery: 3 days')).toBeInTheDocument();
    expect(screen.getByTestId('desk-service-request-state')).toHaveTextContent('Awaiting approval');
    const steps = screen.getAllByTestId('desk-request-step');
    expect(steps).toHaveLength(3);
    expect(within(steps[0]!).getByText('Approved')).toBeInTheDocument();
    expect(within(steps[0]!).getByText(/Approver: Alice · Decided by Alice/)).toBeInTheDocument();
    expect(within(steps[0]!).getByText(/Within budget/)).toBeInTheDocument();
    expect(within(steps[1]!).getByText('Pending')).toBeInTheDocument();
    expect(within(steps[2]!).getByText('Step 3')).toBeInTheDocument();
    expect(within(steps[2]!).getByText(/No approver, a catalogue manager decides/)).toBeInTheDocument();
  });

  it('shows an item that was deleted, and a request without approval', () => {
    state.request = { item: null, approvalStatus: null, approvals: [], fulfilmentStarted: false };
    renderSection();
    expect(screen.getByText('Removed from the catalogue')).toBeInTheDocument();
    expect(screen.getByTestId('desk-service-request-state')).toHaveTextContent('No approval needed');
    expect(screen.queryByTestId('desk-request-steps')).not.toBeInTheDocument();
  });

  it('lets the approver of the pending step approve with a comment', async () => {
    state.request = request([step(0, { approverId: 'user_me', status: 'pending' })]);
    renderSection();
    fireEvent.click(screen.getByTestId('desk-request-approve'));
    const dialog = await screen.findByTestId('desk-request-decision-dialog');
    expect(within(dialog).getByText('Approve this request')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Comment'), { target: { value: 'Go ahead' } });
    fireEvent.click(within(dialog).getByTestId('desk-request-decision-confirm'));
    expect(state.decide).toHaveBeenCalledTimes(1);
    expect(state.decide.mock.calls[0]![0]).toEqual({ conversationId: 'dconv_1', decision: 'approved', comment: 'Go ahead' });
  });

  it('rejects, and cancelling sends nothing', async () => {
    state.request = request([step(0, { approverId: 'user_me', status: 'pending' })]);
    renderSection();
    fireEvent.click(screen.getByTestId('desk-request-reject'));
    let dialog = await screen.findByTestId('desk-request-decision-dialog');
    expect(within(dialog).getByText('Reject this request')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(state.decide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('desk-request-reject'));
    dialog = await screen.findByTestId('desk-request-decision-dialog');
    fireEvent.click(within(dialog).getByTestId('desk-request-decision-confirm'));
    expect(state.decide.mock.calls[0]![0]).toEqual({ conversationId: 'dconv_1', decision: 'rejected', comment: '' });
  });

  it('offers the buttons only to the approver or a catalogue manager', () => {
    state.request = request([step(0, { approverId: 'user_alice', status: 'pending' })]);
    const { unmount } = renderSection();
    expect(screen.queryByTestId('desk-request-approve')).not.toBeInTheDocument();
    unmount();

    state.perms = new Set(['welddesk:settings:update']);
    renderSection();
    expect(screen.getByTestId('desk-request-approve')).toBeInTheDocument();
    expect(screen.getByTestId('desk-request-reject')).toBeInTheDocument();
  });

  it('has no buttons once nothing is pending', () => {
    state.request = request([step(0, { approverId: 'user_me', status: 'approved' })], 'approved');
    renderSection();
    expect(screen.getByTestId('desk-service-request-state')).toHaveTextContent('Approved');
    expect(screen.queryByTestId('desk-request-approve')).not.toBeInTheDocument();
  });
});

describe('a conversation that is no request', () => {
  beforeEach(() => {
    state.items = [
      { id: 'dcat_1', name: 'Laptop', summary: 'A work laptop', category: 'Hardware', icon: null },
      { id: 'dcat_2', name: 'VPN access', summary: null, category: 'Access', icon: null },
    ];
  });

  it('shows nothing without conversations:update, on a closed or a merged conversation, or while loading', () => {
    const { unmount } = renderSection();
    expect(screen.queryByTestId('desk-service-request')).not.toBeInTheDocument();
    unmount();

    state.perms = new Set(['conversations:update']);
    const closed = renderSection({ state: 'closed' });
    expect(screen.queryByTestId('desk-service-request')).not.toBeInTheDocument();
    closed.unmount();
    const merged = renderSection({ mergedIntoId: 'dconv_9' });
    expect(screen.queryByTestId('desk-service-request')).not.toBeInTheDocument();
    merged.unmount();

    state.loading = true;
    state.request = undefined;
    renderSection();
    expect(screen.queryByTestId('desk-service-request')).not.toBeInTheDocument();
  });

  it('starts a request from the picked item', async () => {
    state.perms = new Set(['conversations:update']);
    renderSection();
    fireEvent.click(screen.getByTestId('desk-service-request-make'));
    const dialog = await screen.findByTestId('desk-request-picker');
    const start = within(dialog).getByTestId('desk-request-start');
    expect(start).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('option', { name: /VPN access/ }));
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(state.attach).toHaveBeenCalledTimes(1);
    expect(state.attach.mock.calls[0]![0]).toEqual({ conversationId: 'dconv_1', catalogItemId: 'dcat_2' });
  });

  it('sends a refusal back into the picker', async () => {
    state.perms = new Set(['conversations:update']);
    renderSection();
    fireEvent.click(screen.getByTestId('desk-service-request-make'));
    const dialog = await screen.findByTestId('desk-request-picker');
    fireEvent.click(within(dialog).getByRole('option', { name: /Laptop/ }));
    fireEvent.click(within(dialog).getByTestId('desk-request-start'));
    state.attach.mock.calls[0]![1].onError?.({ reason: 'already_request' });
    expect(await within(dialog).findByText('This ticket is already a service request.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('desk-request-picker')).toBeInTheDocument());
  });

  it('tells an empty catalogue', async () => {
    state.items = [];
    state.perms = new Set(['conversations:update']);
    renderSection();
    fireEvent.click(screen.getByTestId('desk-service-request-make'));
    expect(await screen.findByText('The catalogue has no items yet.')).toBeInTheDocument();
  });
});

describe('creating the tasks again', () => {
  const unstarted = (approvalStatus: string | null) => ({ ...request([], approvalStatus), fulfilmentStarted: false });

  it('offers the button on an approved request whose tasks were never created', () => {
    state.perms = new Set(['conversations:update']);
    state.request = unstarted('approved');
    renderSection();
    fireEvent.click(screen.getByTestId('desk-request-create-tasks'));
    expect(state.createTasks).toHaveBeenCalledTimes(1);
    expect(state.createTasks.mock.calls[0]![0]).toBe('dconv_1');
  });

  it('offers it on a request that needs no approval', () => {
    state.perms = new Set(['conversations:update']);
    state.request = unstarted(null);
    renderSection();
    expect(screen.getByTestId('desk-request-create-tasks')).toBeInTheDocument();
  });

  it('is not there while approval is pending or after a rejection', () => {
    state.perms = new Set(['conversations:update']);
    for (const status of ['pending', 'rejected']) {
      state.request = unstarted(status);
      const { unmount } = renderSection();
      expect(screen.queryByTestId('desk-request-create-tasks')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('is not there once the tasks were created, or without conversations:update', () => {
    state.perms = new Set(['conversations:update']);
    state.request = request([], 'approved');
    const { unmount } = renderSection();
    expect(screen.queryByTestId('desk-request-create-tasks')).not.toBeInTheDocument();
    unmount();

    state.perms = new Set();
    state.request = unstarted('approved');
    renderSection();
    expect(screen.queryByTestId('desk-request-create-tasks')).not.toBeInTheDocument();
  });

  it('is not there when the item was removed', () => {
    state.perms = new Set(['conversations:update']);
    state.request = { item: null, approvalStatus: null, approvals: [], fulfilmentStarted: false };
    renderSection();
    expect(screen.queryByTestId('desk-request-create-tasks')).not.toBeInTheDocument();
  });

  it('is not there when the item creates no tasks', () => {
    state.perms = new Set(['conversations:update']);
    const base = unstarted('approved');
    state.request = { ...base, item: { ...base.item, fulfilmentTaskCount: 0 } };
    renderSection();
    expect(screen.queryByTestId('desk-request-create-tasks')).not.toBeInTheDocument();
  });

  it('says how many tasks it created, and the refusal when the server refuses', () => {
    state.perms = new Set(['conversations:update']);
    state.request = unstarted('approved');
    renderSection();
    fireEvent.click(screen.getByTestId('desk-request-create-tasks'));
    state.createTasks.mock.calls[0]![1].onSuccess?.({ created: 2 });
    state.createTasks.mock.calls[0]![1].onError?.({ reason: 'already_started' });
    expect(toast.success).toHaveBeenCalledWith('2 tasks created');
    expect(toast.error).toHaveBeenCalledWith('The tasks of this request were created already.');
  });
});
