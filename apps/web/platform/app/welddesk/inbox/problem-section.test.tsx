/**
 * The Problem section of the details panel: the linked problem with its
 * workaround, linking through the picker with a refusal sent back to it,
 * creating a problem from the ticket, and unlinking.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

interface Callbacks {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
}

const state = vi.hoisted(() => ({
  linked: null as unknown,
  loading: false,
  perms: new Set<string>(),
  set: vi.fn<(input: { id: string; problemId: string | null }, callbacks: Callbacks) => void>(),
  create: vi.fn<(input: { title: string; conversationIds: string[] }, callbacks: Callbacks) => void>(),
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode; 'data-testid'?: string }) => (
    <a href={href} data-testid={rest['data-testid']}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-desk-link-queries', () => ({
  deskLinkErrorMessage: () => null,
  deskLinkRefusal: (err: { reason?: string }) => err.reason ?? null,
}));
vi.mock('@/hooks/queries/use-desk-problem-queries', () => ({
  useDeskConversationProblem: () => ({ data: state.linked, isLoading: state.loading }),
  useSetDeskConversationProblem: () => ({ mutate: state.set, isPending: false }),
  useCreateDeskProblem: () => ({ mutate: state.create, isPending: false }),
}));
// The picker has its own search query; an open dialog with one row stands in.
vi.mock('./problem-picker-dialog', () => ({
  ProblemPickerDialog: ({
    open,
    notice,
    onPick,
  }: {
    open: boolean;
    notice?: ReactNode;
    onPick: (problem: { id: string; problemNumber: number }) => void;
  }) =>
    open ? (
      <div data-testid="picker">
        {notice}
        <button type="button" onClick={() => onPick({ id: 'dprob_9', problemNumber: 9 })}>
          pick #9
        </button>
      </div>
    ) : null,
}));

import { ProblemSection } from './problem-section';

const ticket = { id: 'dconv_1', conversationNumber: 12, title: 'Cannot pay' } as never;
const problem = {
  id: 'dprob_4',
  problemNumber: 4,
  title: 'Checkout fails',
  status: 'known_error',
  workaround: 'Use PayPal instead',
  rootCause: null,
};

beforeEach(() => {
  state.linked = null;
  state.loading = false;
  state.perms = new Set(['conversations:update', 'problems:read', 'problems:create']);
  state.set.mockReset();
  state.create.mockReset();
});
afterEach(cleanup);

describe('ProblemSection', () => {
  it('shows the linked problem with a link to it, its status and its workaround', () => {
    state.linked = problem;
    render(<ProblemSection conversation={ticket} />);
    const link = screen.getByTestId('desk-inbox-problem-link');
    expect(link.textContent).toBe('#4 Checkout fails');
    expect(link.getAttribute('href')).toBe('/welddesk/problems/dprob_4');
    expect(screen.getByTestId('desk-problem-status').textContent).toBe('Known error');
    expect(screen.getByTestId('desk-inbox-problem-workaround').textContent).toContain('Use PayPal instead');
  });

  it('says there is no workaround yet for a known error without one, and nothing for others', () => {
    state.linked = { ...problem, workaround: null };
    const { unmount } = render(<ProblemSection conversation={ticket} />);
    expect(screen.getByText('No workaround yet.')).toBeTruthy();
    unmount();
    state.linked = { ...problem, workaround: null, status: 'investigating' };
    render(<ProblemSection conversation={ticket} />);
    expect(screen.queryByText('No workaround yet.')).toBeNull();
  });

  it('unlinks the problem', () => {
    state.linked = problem;
    render(<ProblemSection conversation={ticket} />);
    fireEvent.click(screen.getByTestId('desk-problem-unlink'));
    expect(state.set.mock.calls[0]![0]).toEqual({ id: 'dconv_1', problemId: null });
  });

  it('links the picked problem, and shows a refusal inside the picker', async () => {
    render(<ProblemSection conversation={ticket} />);
    expect(screen.getByText('Not linked to a problem.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('desk-problem-link'));
    fireEvent.click(screen.getByText('pick #9'));
    expect(state.set.mock.calls[0]![0]).toEqual({ id: 'dconv_1', problemId: 'dprob_9' });

    state.set.mock.calls[0]![1].onError?.({ reason: 'problem_closed' });
    const picker = await screen.findByTestId('picker');
    expect(picker.textContent).toContain('This problem is closed and takes no new tickets.');

    state.set.mock.calls[0]![1].onSuccess?.({});
    await vi.waitFor(() => expect(screen.queryByTestId('picker')).toBeNull());
  });

  it('creates a problem from the ticket with its title and the ticket linked', () => {
    render(<ProblemSection conversation={ticket} />);
    fireEvent.click(screen.getByTestId('desk-problem-create'));
    expect(state.create.mock.calls[0]![0]).toEqual({ title: 'Cannot pay', conversationIds: ['dconv_1'] });
  });

  it('falls back to the ticket number when the ticket has no title', () => {
    render(<ProblemSection conversation={{ id: 'dconv_2', conversationNumber: 13, title: null } as never} />);
    fireEvent.click(screen.getByTestId('desk-problem-create'));
    expect(state.create.mock.calls[0]![0]).toEqual({ title: 'Ticket #13', conversationIds: ['dconv_2'] });
  });

  it('offers no way to create once a problem is linked', () => {
    state.linked = problem;
    render(<ProblemSection conversation={ticket} />);
    expect(screen.queryByTestId('desk-problem-create')).toBeNull();
    expect(screen.getByTestId('desk-problem-link')).toBeTruthy();
  });

  it('only shows the problem to those who may not change it', () => {
    state.linked = problem;
    state.perms = new Set(['conversations:read']);
    render(<ProblemSection conversation={ticket} />);
    expect(screen.getByTestId('desk-inbox-problem-link')).toBeTruthy();
    expect(screen.queryByTestId('desk-problem-link')).toBeNull();
    expect(screen.queryByTestId('desk-problem-unlink')).toBeNull();
  });

  it('hides the create and link buttons without problems:create / problems:read', () => {
    state.perms = new Set(['conversations:update']);
    render(<ProblemSection conversation={ticket} />);
    expect(screen.queryByTestId('desk-problem-create')).toBeNull();
    expect(screen.queryByTestId('desk-problem-link')).toBeNull();
  });

  it('offers to create, link and unlink only with conversations:update', () => {
    state.perms = new Set(['problems:read', 'problems:create']);
    const { unmount } = render(<ProblemSection conversation={ticket} />);
    expect(screen.queryByTestId('desk-problem-create')).toBeNull();
    expect(screen.queryByTestId('desk-problem-link')).toBeNull();
    unmount();

    state.linked = problem;
    render(<ProblemSection conversation={ticket} />);
    expect(screen.queryByTestId('desk-problem-unlink')).toBeNull();
  });
});
