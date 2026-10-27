import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  canUse: true,
  pending: [{ id: 'apr_1' }] as Array<{ id: string }>,
  fetched: true,
  decide: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        approvalCard: {
          waitingFor: 'Waiting for approval: {label}',
          approve: 'Approve',
          reject: 'Reject',
          approved: 'Approved: {label}',
          rejected: 'Rejected: {label}',
          alreadyHandled: 'Already handled: {label}',
          decideFailed: 'Could not send your decision.',
          notAllowed: 'Only the owner can decide.',
          actionFailed: 'Action failed: {error}',
        },
      },
    },
  }),
}));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => state.canUse }));
vi.mock('@/hooks/queries/use-agent-parity-queries', () => ({
  useAgentApprovals: (agentId: string) => ({
    data: agentId ? state.pending : undefined,
    isFetchedAfterMount: state.fetched,
  }),
  useDecideAgentApproval: () => ({ mutateAsync: state.decide, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: state.toastError } }));

import { MessageApprovals } from './message-approvals';

const label = 'Create task "QA agent chat task"';
const now = () => new Date().toISOString();

function renderApprovals(overrides: Partial<Parameters<typeof MessageApprovals>[0]['message']> = {}) {
  return render(
    <MessageApprovals
      message={{
        authorId: 'agt_1',
        authorType: 'agent',
        createdAt: now(),
        metadata: { approvals: [{ id: 'apr_1', label, status: 'pending' }] },
        ...overrides,
      }}
    />,
  );
}

class StatusError extends Error {
  readonly isApiError = true;
  constructor(readonly status: number) {
    super(`status ${status}`);
  }
}

beforeEach(() => {
  state.canUse = true;
  state.pending = [{ id: 'apr_1' }];
  state.fetched = true;
  state.decide.mockReset();
  state.decide.mockResolvedValue({ id: 'apr_1', status: 'approved' });
  state.toastError.mockReset();
});

describe('MessageApprovals', () => {
  it('renders nothing for a message without approvals, or one that is not from an agent', () => {
    const { container, rerender } = renderApprovals({ metadata: {} });
    expect(container).toBeEmptyDOMElement();
    rerender(<MessageApprovals message={{ authorId: 'u1', authorType: 'user', metadata: { approvals: [{ id: 'a', label: 'x', status: 'pending' }] } }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows what the agent is waiting on, with Approve and Reject', () => {
    renderApprovals();
    expect(screen.getByText(`Waiting for approval: ${label}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('shows the card without buttons to someone who may not decide', () => {
    state.canUse = false;
    renderApprovals();
    expect(screen.getByText(`Waiting for approval: ${label}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('approving sends the decision and shows Approved at once', async () => {
    let resolve: (value: unknown) => void = () => {};
    state.decide.mockReturnValue(new Promise((r) => (resolve = r)));
    renderApprovals();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(state.decide).toHaveBeenCalledWith({ id: 'apr_1', decision: 'approved' });
    expect(screen.getByText(`Approved: ${label}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    resolve({ id: 'apr_1' });
    await waitFor(() => expect(state.toastError).not.toHaveBeenCalled());
  });

  it('rejecting sends the decision and shows Rejected', () => {
    renderApprovals();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(state.decide).toHaveBeenCalledWith({ id: 'apr_1', decision: 'rejected' });
    expect(screen.getByText(`Rejected: ${label}`)).toBeTruthy();
  });

  it('tells the person when an approved action then failed', async () => {
    state.decide.mockResolvedValue({ id: 'apr_1', execution: { ran: true, ok: false, error: 'No project' } });
    renderApprovals();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Action failed: No project'));
  });

  it.each([404, 409])('shows a neutral "Already handled" when the server says %i', async (status) => {
    state.decide.mockRejectedValue(new StatusError(status));
    renderApprovals();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(`Already handled: ${label}`)).toBeTruthy());
    expect(state.toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('puts the buttons back and explains when someone else owns the decision (403)', async () => {
    state.decide.mockRejectedValue(new StatusError(403));
    renderApprovals();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Only the owner can decide.'));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('puts the buttons back after any other failure', async () => {
    state.decide.mockRejectedValue(new Error('network'));
    renderApprovals();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('Could not send your decision.'));
    expect(screen.getByText(`Waiting for approval: ${label}`)).toBeTruthy();
  });

  it('shows "Already handled" for an older approval the agent no longer lists as pending', () => {
    state.pending = [];
    renderApprovals({ createdAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(screen.getByText(`Already handled: ${label}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('keeps waiting while the pending list has not been read yet', () => {
    state.fetched = false;
    state.pending = [];
    renderApprovals({ createdAt: new Date(Date.now() - 60 * 60_000).toISOString() });
    expect(screen.getByText(`Waiting for approval: ${label}`)).toBeTruthy();
  });

  it('shows a status the message itself carries', () => {
    renderApprovals({ metadata: { approvals: [{ id: 'apr_1', label, status: 'approved' }] } });
    expect(screen.getByText(`Approved: ${label}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
