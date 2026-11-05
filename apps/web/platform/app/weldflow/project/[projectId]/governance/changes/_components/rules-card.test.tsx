import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

import { RulesCard } from './rules-card';
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

describe('RulesCard gating', () => {
  it('lets a manager edit the limits and save', () => {
    render(<RulesCard projectId="p1" control={control()} members={members} canEdit />);
    expect((screen.getByLabelText('Cost limit (EUR)') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Save rules' })).toBeTruthy();
    expect(screen.getAllByText('No change board').length).toBeGreaterThan(0);
  });

  it('shows everybody else the rules read-only, without a save button', () => {
    render(<RulesCard projectId="p1" control={control({ changeControl: { costLimit: 1000, scheduleLimitDays: 2, boardMemberIds: ['u2'] }, warnings: [] })} members={members} canEdit={false} />);
    expect((screen.getByLabelText('Cost limit (EUR)') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Cost limit (EUR)') as HTMLInputElement).value).toBe('1000');
    expect(screen.queryByRole('button', { name: 'Save rules' })).toBeNull();
    expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
    expect(screen.getByText(en.flowApprovals.changes.rules.managerOnly)).toBeTruthy();
    expect(screen.queryByText('No change board')).toBeNull();
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
