import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { MyReviews, ReviewItem } from '@weldsuite/app-api-client/domains/flow-approvals';

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate, plural: () => '' }),
}));
vi.mock('@/hooks/queries/use-flow-approvals-queries', () => ({
  useDecideReview: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ReviewBuckets } from './review-list';
import { ReviewDetail } from './review-detail';

const review = (overrides: Partial<ReviewItem> = {}): ReviewItem => ({
  id: 'apr_1',
  source: 'approval',
  type: 'change_request',
  subjectId: 'pcr_1',
  projectId: 'p1',
  projectName: 'Launch',
  code: 'CR-8',
  title: 'Move the beta',
  summary: 'The supplier is late',
  requestedBy: 'u2',
  requestedAt: '2026-11-01T00:00:00.000Z',
  dueAt: '2026-11-06T00:00:00.000Z',
  bucket: 'this_week',
  decision: 'pending',
  note: null,
  decidedAt: null,
  step: 1,
  roleLabel: 'Project manager',
  rule: { code: 'change_manager' },
  viaDelegation: false,
  delegatedFrom: null,
  actionable: true,
  approvers: [{ approvalId: 'apr_1', approverKind: 'member', approverId: 'u1', roleLabel: null, step: 1, decision: 'pending', note: null, decidedAt: null, delegatedFrom: null }],
  impacts: [{ kind: 'cost', value: '4000.00', currency: 'EUR' }],
  links: [{ type: 'milestone', id: 'm1', title: 'Beta release', code: null, relation: 'moves' }],
  ...overrides,
});

const nameOf = (id: string | null | undefined) => `name-${id}`;

describe('ReviewBuckets', () => {
  it('shows the groups that have reviews, with their counts, and leaves empty groups out', () => {
    const groups: MyReviews['groups'] = {
      overdue: [review({ id: 'a', title: 'Late one', bucket: 'overdue' })],
      this_week: [],
      later: [review({ id: 'b', title: 'Far away', bucket: 'later' }), review({ id: 'c', title: 'No date', bucket: 'later', dueAt: null })],
    };
    render(<ReviewBuckets groups={groups} selectedId="b" nameOf={nameOf} onSelect={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Overdue' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'This week' })).toBeNull();
    const later = screen.getByRole('region', { name: 'Later' });
    expect(within(later).getAllByRole('listitem')).toHaveLength(2);
    expect(within(later).getByText('2')).toBeTruthy();
    expect(screen.getByText('Far away').closest('button')?.getAttribute('aria-current')).toBe('true');
  });

  it('selects a review on click', async () => {
    const onSelect = vi.fn();
    render(<ReviewBuckets groups={{ overdue: [], this_week: [review()], later: [] }} selectedId={null} nameOf={nameOf} onSelect={onSelect} />);
    await userEvent.click(screen.getByText('Move the beta'));
    expect(onSelect).toHaveBeenCalledWith('apr_1');
  });
});

describe('ReviewDetail', () => {
  beforeEach(() => mocks.mutateAsync.mockReset().mockResolvedValue({}));

  it('explains why the reviewer was asked and what it means', () => {
    render(<ReviewDetail review={review()} nameOf={nameOf} onClose={vi.fn()} />);
    expect(screen.getByText(en.flowApprovals.reviews.rules.change_manager)).toBeTruthy();
    expect(screen.getByText('Beta release')).toBeTruthy();
    expect(screen.getByText('Moves')).toBeTruthy();
  });

  it('refuses a decline without a comment, then sends it with one', async () => {
    const onClose = vi.fn();
    render(<ReviewDetail review={review()} nameOf={nameOf} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect((await screen.findByRole('alert')).textContent).toBe(en.flowApprovals.reviews.detail.commentRequired);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Comment'), 'Too expensive');
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({ id: 'apr_1', decision: 'rejected', note: 'Too expensive' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('approves without a comment', async () => {
    render(<ReviewDetail review={review()} nameOf={nameOf} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({ id: 'apr_1', decision: 'approved', note: null }));
  });

  it('offers a time entry only approve and decline, and a finished review no form', () => {
    const { unmount } = render(<ReviewDetail review={review({ source: 'timesheet', type: 'timesheet', rule: null })} nameOf={nameOf} onClose={vi.fn()} />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(expect.arrayContaining(['Approve', 'Decline']));
    expect(screen.queryByRole('button', { name: 'Ask for more information' })).toBeNull();
    unmount();
    render(<ReviewDetail review={review({ decision: 'approved' })} nameOf={nameOf} onClose={vi.fn()} readOnly />);
    expect(screen.queryByLabelText('Comment')).toBeNull();
  });
});
