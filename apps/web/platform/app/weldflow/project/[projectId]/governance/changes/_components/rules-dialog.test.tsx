import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { ChangeControlResponse } from '@weldsuite/app-api-client/domains/flow-approvals';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate, plural: () => '' }),
}));
vi.mock('@/hooks/queries/use-flow-approvals-queries', () => ({
  useSetChangeControl: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetProjectSponsor: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { RulesDialog, RulesForm } from './rules-dialog';
import { changeBodyFrom, changeFormSchema, emptyChangeForm } from './change-form';
import { changeActions } from './change-detail';

const control = (overrides: Partial<ChangeControlResponse> = {}): ChangeControlResponse => ({
  projectId: 'p1',
  changeControl: { costLimit: 5000, scheduleLimitDays: 5, boardMemberIds: [] },
  configured: false,
  sponsorId: null,
  projectManagerId: 'u1',
  currency: 'EUR',
  warnings: ['no_board'],
  ...overrides,
});

const members = [{ userId: 'u1', name: 'Ann' }, { userId: 'u2', name: 'Bob' }];

describe('Approval rules gating', () => {
  it('lets a manager edit the limits and save', () => {
    render(<RulesForm projectId="p1" control={control()} members={members} canEdit onClose={vi.fn()} />);
    expect((screen.getByLabelText('Cost limit (EUR)') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeTruthy();
    expect(screen.getAllByText('No change board').length).toBeGreaterThan(0);
  });

  it('shows everybody else the rules read-only, without a save button', () => {
    render(<RulesForm projectId="p1" control={control({ changeControl: { costLimit: 1000, scheduleLimitDays: 2, boardMemberIds: ['u2'] }, warnings: [] })} members={members} canEdit={false} onClose={vi.fn()} />);
    expect((screen.getByLabelText('Cost limit (EUR)') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Cost limit (EUR)') as HTMLInputElement).value).toBe('1000');
    expect(screen.queryByRole('button', { name: 'Save rules' })).toBeNull();
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
    expect(screen.getByText(en.flowApprovals.changes.rules.managerOnly)).toBeTruthy();
    expect(screen.queryByText('No change board')).toBeNull();
    expect(screen.queryByText(en.flowApprovals.changes.rules.noBoardWarning)).toBeNull();
  });

  it('warns when no board is set', () => {
    render(<RulesForm projectId="p1" control={control()} members={members} canEdit onClose={vi.fn()} />);
    expect(screen.getByText(en.flowApprovals.changes.rules.noBoardWarning)).toBeTruthy();
  });

  it('lets a manager cancel and a reader close', () => {
    const onClose = vi.fn();
    const { unmount } = render(<RulesForm projectId="p1" control={control()} members={members} canEdit onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    render(<RulesForm projectId="p1" control={control()} members={members} canEdit={false} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('RulesDialog', () => {
  it('shows the rules in a dialog under their title and description', () => {
    render(<RulesDialog open onOpenChange={vi.fn()} projectId="p1" control={control()} members={members} canEdit />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(en.flowApprovals.changes.rules.title)).toBeTruthy();
    expect(within(dialog).getByText(en.flowApprovals.changes.rules.description)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save rules' })).toBeTruthy();
  });

  it('renders nothing while closed', () => {
    render(<RulesDialog open={false} onOpenChange={vi.fn()} projectId="p1" control={control()} members={members} canEdit />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('change actions', () => {
  const abilities = { write: true, remove: true, manage: false };

  it('submits and edits a draft, withdraws only as the requester or a manager, deletes only a draft or withdrawn change', () => {
    expect(changeActions({ status: 'draft', requestedBy: 'u1' }, abilities, 'u1')).toEqual({ edit: true, submit: true, withdraw: true, remove: true });
    expect(changeActions({ status: 'awaiting_approval', requestedBy: 'u1' }, abilities, 'u2')).toEqual({ edit: true, submit: false, withdraw: false, remove: false });
    expect(changeActions({ status: 'awaiting_approval', requestedBy: 'u1' }, { ...abilities, manage: true }, 'u2').withdraw).toBe(true);
    expect(changeActions({ status: 'withdrawn', requestedBy: 'u1' }, abilities, 'u1')).toEqual({ edit: false, submit: false, withdraw: false, remove: true });
    expect(changeActions({ status: 'approved', requestedBy: 'u1' }, abilities, 'u1')).toEqual({ edit: false, submit: false, withdraw: false, remove: false });
  });

  it('gives a viewer nothing', () => {
    expect(changeActions({ status: 'draft', requestedBy: 'u1' }, { write: false, remove: false, manage: false }, 'u1')).toEqual({ edit: false, submit: false, withdraw: false, remove: false });
  });
});

describe('change form', () => {
  const schema = changeFormSchema({ titleRequired: 'title', numberInvalid: 'number' });

  it('needs a title and numbers where numbers go', () => {
    expect(schema.safeParse(emptyChangeForm()).success).toBe(false);
    expect(schema.safeParse({ ...emptyChangeForm(), title: 'Move', costDelta: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ ...emptyChangeForm(), title: 'Move', scheduleDeltaDays: '1.5' }).success).toBe(false);
    expect(schema.safeParse({ ...emptyChangeForm(), title: 'Move', costDelta: '-250.5', scheduleDeltaDays: '3' }).success).toBe(true);
  });

  it('builds the request body, keeping deliverable moves it has no control for', () => {
    const body = changeBodyFrom(
      { ...emptyChangeForm(), title: ' Move ', costDelta: '4000', goLive: '2026-12-09', milestoneMoves: [{ milestoneId: 'm1', to: '2026-11-28' }], addDeliverables: [{ title: 'Training' }] },
      { planChanges: { deliverables: [{ deliverableId: 'd1' }] }, scopeChanges: { remove: ['d2'] } },
    );
    expect(body).toEqual({
      title: 'Move',
      description: null,
      costDelta: 4000,
      scheduleDeltaDays: null,
      planChanges: {
        goLive: '2026-12-09T00:00:00.000Z',
        milestones: [{ milestoneId: 'm1', to: '2026-11-28T00:00:00.000Z' }],
        deliverables: [{ deliverableId: 'd1' }],
      },
      scopeChanges: { add: [{ title: 'Training' }], remove: ['d2'] },
    });
    expect(changeBodyFrom(emptyChangeForm()).planChanges).toBeNull();
  });
});
