import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorHTMLAttributes } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { ChangeRequest, ChangeRequestDetail } from '@weldsuite/app-api-client/domains/flow-approvals';

const state = vi.hoisted(() => ({
  abilities: { write: true, remove: true, manage: false },
  userId: 'u1' as string | null,
  closeAll: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate, plural: () => '' }),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ closeAll: state.closeAll }),
  useObjectPanelNavigationReporter: () => vi.fn(),
}));
vi.mock('./use-change-abilities', () => ({
  useChangeAbilities: () => ({ abilities: state.abilities, userId: state.userId, canCreate: true, canEditRules: false }),
}));
vi.mock('@/app/weldflow/_approvals/use-member-names', () => ({
  useMemberNames: () => ({ members: [], nameOf: (id: string | null | undefined) => (id === 'u2' ? 'Bob Jones' : 'Unknown member'), isLoading: false }),
}));
vi.mock('@/hooks/queries/use-flow-approvals-queries', () => ({
  useSubmitChangeRequest: () => ({ mutateAsync: state.submit, isPending: false }),
  useWithdrawChangeRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteChangeRequest: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ChangeRequestList } from './change-list';
import { ChangeApprovalsTab, ChangeDetailsTab } from './change-detail';
import { EMPTY_CHANGE_FILTERS } from './change-filters';

const change = (overrides: Partial<ChangeRequest>): ChangeRequest =>
  ({
    id: 'c1',
    projectId: 'p1',
    number: 1,
    code: 'CR-1',
    title: 'Move go-live',
    description: null,
    requestedBy: 'u1',
    requestedByName: 'Ann Smith',
    status: 'draft',
    costDelta: '4000',
    scheduleDeltaDays: 3,
    planChanges: null,
    scopeChanges: null,
    route: null,
    submittedAt: null,
    decidedAt: null,
    baselineId: null,
    clientVisible: false,
    createdBy: 'u1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  }) as ChangeRequest;

const changes = [
  change({ id: 'c1', code: 'CR-1', title: 'Move go-live' }),
  change({ id: 'c2', code: 'CR-2', title: 'Extra training', status: 'awaiting_approval', route: 'board', costDelta: null, scheduleDeltaDays: null }),
  change({ id: 'c3', code: 'CR-3', title: 'Cut the pilot', status: 'approved', route: 'manager', requestedBy: 'u2', requestedByName: null, costDelta: '-250', scheduleDeltaDays: -2 }),
];

function renderList(overrides: Partial<Parameters<typeof ChangeRequestList>[0]> = {}) {
  const props = {
    changes,
    filters: EMPTY_CHANGE_FILTERS,
    onFiltersChange: vi.fn(),
    currency: 'EUR',
    selectedId: null,
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onCreate: vi.fn(),
    ...overrides,
  };
  render(<ChangeRequestList {...props} />);
  return props;
}

beforeEach(() => {
  state.abilities = { write: true, remove: true, manage: false };
  state.userId = 'u1';
  state.closeAll.mockReset();
  state.submit.mockReset();
  state.submit.mockResolvedValue(undefined);
});

describe('ChangeRequestList', () => {
  it('lists a row per change with its code, title and translated status, never the raw status', () => {
    renderList();
    expect(screen.getByRole('button', { name: 'CR-1 Move go-live' })).toBeTruthy();
    expect(screen.getByText('Extra training')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByText('awaiting_approval')).toBeNull();
  });

  it('shows the route, the cost and the schedule of a change, and a dash for what it does not have', () => {
    renderList();
    expect(screen.getByText('Change board')).toBeTruthy();
    expect(screen.getByText('Project manager')).toBeTruthy();
    expect(screen.getByText('3 working days')).toBeTruthy();
    expect(screen.getByText('-2 working days')).toBeTruthy();
    expect(screen.getByText(/4,000/)).toBeTruthy();
    expect(screen.getByText(/250/)).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('names the requester, from the row or from the members', () => {
    renderList();
    expect(screen.getAllByText('Ann').length).toBeGreaterThan(0);
    expect(screen.getByText('Bob')).toBeTruthy();
  });

  it('opens a change from the whole row', async () => {
    const { onSelect } = renderList();
    await userEvent.click(screen.getByRole('button', { name: 'CR-2 Extra training' }));
    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('marks the open change', () => {
    renderList({ selectedId: 'c2' });
    const row = screen.getByRole('button', { name: 'CR-2 Extra training' }).parentElement;
    expect(row?.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'CR-1 Move go-live' }).parentElement?.getAttribute('aria-current')).toBeNull();
  });

  it('offers a draft its edit, submit, withdraw and delete, and nothing to an approved change', async () => {
    renderList();
    const rows = screen.getAllByRole('button', { name: en.flowApprovals.changes.moreActions });
    // The approved change has no menu at all.
    expect(rows).toHaveLength(2);
    await userEvent.click(rows[0]);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Submit for approval' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Withdraw' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });

  it('submits from the menu', async () => {
    renderList();
    await userEvent.click(screen.getAllByRole('button', { name: en.flowApprovals.changes.moreActions })[0]);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Submit for approval' }));
    expect(state.submit).toHaveBeenCalledWith('c1');
  });

  it('asks before it withdraws', async () => {
    renderList();
    await userEvent.click(screen.getAllByRole('button', { name: en.flowApprovals.changes.moreActions })[0]);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Withdraw CR-1?')).toBeTruthy();
  });

  it('gives a viewer no menu', () => {
    state.abilities = { write: false, remove: false, manage: false };
    renderList();
    expect(screen.queryByRole('button', { name: en.flowApprovals.changes.moreActions })).toBeNull();
  });

  it('lets only a manager or the requester withdraw', async () => {
    state.userId = 'u9';
    renderList();
    await userEvent.click(screen.getAllByRole('button', { name: en.flowApprovals.changes.moreActions })[0]);
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Withdraw' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Submit for approval' })).toBeTruthy();
  });

  it('shows the illustrated empty state with a way to start one when nothing exists yet', async () => {
    const { onCreate } = renderList({ changes: [] });
    expect(screen.getByText(en.flowApprovals.changes.empty)).toBeTruthy();
    expect(screen.getByText(en.flowApprovals.changes.emptyDescription)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: en.flowApprovals.changes.new }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('shows a reader the empty state without the button', () => {
    renderList({ changes: [], onCreate: undefined });
    expect(screen.getByText(en.flowApprovals.changes.emptyReadOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.flowApprovals.changes.new })).toBeNull();
  });

  it('says nothing matches when the search or filters leave nothing', () => {
    renderList({ changes: [], filters: { search: 'nothing like this', filters: [] } });
    expect(screen.getByText(en.flowApprovals.changes.emptyFiltered)).toBeTruthy();
    expect(screen.queryByText(en.flowApprovals.changes.empty)).toBeNull();
  });
});

const detail = (overrides: Partial<ChangeRequestDetail> = {}): ChangeRequestDetail =>
  ({
    ...change({ status: 'awaiting_approval', route: 'board', description: 'The vendor is late.', submittedAt: '2026-11-03T00:00:00.000Z' }),
    approvers: [
      { approvalId: 'a1', approverKind: 'user', approverId: 'u2', roleLabel: 'Change board', step: 1, decision: 'pending', note: null, decidedAt: null, delegatedFrom: null },
      { approvalId: 'a2', approverKind: 'user', approverId: 'u2', roleLabel: null, step: 1, decision: 'rejected', note: 'Too late.', decidedAt: '2026-11-04T00:00:00.000Z', delegatedFrom: null },
    ],
    effects: {
      goLive: { from: '2026-12-01T00:00:00.000Z', to: '2026-12-09T00:00:00.000Z', deltaDays: 8 },
      milestones: [],
      deliverables: { moved: [], added: [{ title: 'Training', plannedStart: null, plannedEnd: null }], removed: [] },
      budget: null,
    },
    routing: { route: 'board', overLimit: true, costLimit: 5000, scheduleLimitDays: 5, noBoard: false },
    baselineVersion: null,
    canDecide: true,
    ...overrides,
  }) as ChangeRequestDetail;

const nameOf = (id: string | null | undefined) => (id === 'u2' ? 'Bob Jones' : 'Unknown member');

describe('ChangeDetailsTab', () => {
  it('reads as flush sections: the status, why, who and when, the impact and what changes', () => {
    render(<ChangeDetailsTab change={detail()} currency="EUR" nameOf={nameOf} />);
    expect(screen.getByText('CR-1')).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('The vendor is late.')).toBeTruthy();
    expect(screen.getByText('Ann Smith')).toBeTruthy();
    expect(screen.getByText(en.flowApprovals.changes.detail.impact)).toBeTruthy();
    expect(screen.getByText('3 working days')).toBeTruthy();
    expect(screen.getByText(/Change board · Over a limit/)).toBeTruthy();
    expect(screen.getByText(en.flowApprovals.changes.detail.effects)).toBeTruthy();
    expect(screen.getByText(/Deliverable Training is added/)).toBeTruthy();
    // No cards: the sections are divided by lines, not boxed.
    expect(document.querySelector('.rounded-lg.border')).toBeNull();
  });

  it('says so when a change moves nothing, and what it did once approved', () => {
    const { unmount } = render(
      <ChangeDetailsTab
        change={detail({ effects: { goLive: null, milestones: [], deliverables: { moved: [], added: [], removed: [] }, budget: null } })}
        currency="EUR"
        nameOf={nameOf}
      />,
    );
    expect(screen.getByText(en.flowApprovals.changes.detail.nothing)).toBeTruthy();
    unmount();
    render(<ChangeDetailsTab change={detail({ status: 'approved', baselineVersion: 2 })} currency="EUR" nameOf={nameOf} />);
    expect(screen.getByText(en.flowApprovals.changes.detail.effectsDone)).toBeTruthy();
    expect(screen.getByText('Baseline v2 was created.')).toBeTruthy();
  });

  it('warns when a change over a limit has no board to go to', () => {
    render(<ChangeDetailsTab change={detail({ routing: { route: 'manager', overLimit: true, costLimit: 5000, scheduleLimitDays: 5, noBoard: true } })} currency="EUR" nameOf={nameOf} />);
    expect(screen.getByText(en.flowApprovals.changes.detail.noBoardRouted)).toBeTruthy();
  });
});

describe('ChangeApprovalsTab', () => {
  it('lists who was asked, in what role, what they answered and why', () => {
    render(<ChangeApprovalsTab change={detail()} nameOf={nameOf} />);
    expect(screen.getAllByText('Bob Jones')).toHaveLength(2);
    expect(screen.getByText('Change board')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('Too late.')).toBeTruthy();
    expect(screen.getByRole('link', { name: en.flowApprovals.changes.detail.openReviews }).getAttribute('href')).toBe('/weldflow/reviews');
  });

  it('says nobody has been asked yet, and only points to My reviews for the one who may answer', () => {
    render(<ChangeApprovalsTab change={detail({ approvers: [], canDecide: false })} nameOf={nameOf} />);
    expect(screen.getByText(en.flowApprovals.changes.detail.noApprovers)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
