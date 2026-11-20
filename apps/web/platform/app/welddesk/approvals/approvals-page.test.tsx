/**
 * The approvals page: pending steps as rows that open the conversation, the
 * "Everyone" scope only for catalogue managers, and the empty and error states.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  isError: false,
  perms: new Set<string>(),
  scopes: [] as string[],
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode; 'aria-label'?: string; 'data-testid'?: string }) => (
    <a href={href} aria-label={rest['aria-label']} data-testid={rest['data-testid']}>
      {children}
    </a>
  ),
}));
vi.mock('@/hooks/queries/use-desk-workspace-members', () => ({
  useDeskWorkspaceMembers: () => ({ data: [{ userId: 'user_alice', name: 'Alice' }] }),
}));
vi.mock('@/hooks/queries/use-desk-catalog-queries', () => ({
  useDeskPendingApprovals: (scope: string) => {
    state.scopes.push(scope);
    return { data: state.rows, isLoading: false, isError: state.isError, refetch: vi.fn() };
  },
}));

import { ApprovalsPage } from './approvals-page';

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  approvalId: `dappr_${id}`,
  conversationId: `dconv_${id}`,
  conversationNumber: 40 + Number(id),
  title: `Request ${id}`,
  requesterName: 'Casey',
  conversationCreatedAt: '2026-01-01T09:00:00.000Z',
  catalogItemId: 'dcat_1',
  catalogItemName: 'Laptop',
  stepIndex: 0,
  stepName: 'Budget',
  approverId: 'user_alice',
  requestedAt: '2026-01-01T10:00:00.000Z',
  ...extra,
});

beforeEach(() => {
  state.rows = [row('1'), row('2', { catalogItemName: null, requesterName: null, approverId: null, stepName: null })];
  state.isError = false;
  state.perms = new Set();
  state.scopes = [];
});

afterEach(() => cleanup());

describe('the approvals page', () => {
  it('lists each pending step as a link to its conversation', () => {
    render(<ApprovalsPage />);
    const rows = screen.getAllByTestId('approval-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('href', '/welddesk/inbox/dconv_1');
    expect(within(rows[0]!).getByText('Laptop')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/#41 · Request 1/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Requested by Casey · Step: Budget · Waiting/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Removed item')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Requested by Unknown requester/)).toBeInTheDocument();
  });

  it('only asks for its own approvals without welddesk:settings:update, and has no scope switch', () => {
    render(<ApprovalsPage />);
    expect(state.scopes.every((scope) => scope === 'mine')).toBe(true);
    expect(screen.queryByTestId('approvals-scope-all')).not.toBeInTheDocument();
  });

  it("switches to everyone's approvals for a catalogue manager, naming the approver", () => {
    state.perms = new Set(['welddesk:settings:update']);
    render(<ApprovalsPage />);
    expect(screen.getByTestId('approvals-scope-mine')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('approvals-scope-all'));
    expect(state.scopes.at(-1)).toBe('all');
    expect(screen.getByTestId('approvals-scope-all')).toHaveAttribute('aria-pressed', 'true');
    const rows = screen.getAllByTestId('approval-row');
    expect(within(rows[0]!).getByText(/Approver: Alice/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/No approver/)).toBeInTheDocument();
  });

  it('says so when nothing waits, per scope', () => {
    state.rows = [];
    state.perms = new Set(['welddesk:settings:update']);
    render(<ApprovalsPage />);
    expect(screen.getByText('Nothing to approve')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('approvals-scope-all'));
    expect(screen.getByText('Nothing is waiting')).toBeInTheDocument();
  });

  it('reports a failed load', () => {
    state.isError = true;
    render(<ApprovalsPage />);
    expect(screen.getByText('Could not load the approvals')).toBeInTheDocument();
  });
});
