import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { BaselineComparison } from '@weldsuite/app-api-client/domains/flow-approvals';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate, plural: () => '' }),
}));
vi.mock('@/hooks/queries/use-flow-approvals-queries', () => ({
  useBaselines: () => ({ data: [], isLoading: false, isError: false }),
  useBaselineComparison: () => ({ data: undefined, isLoading: false }),
  useSignOffBaseline: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BaselineOverlay, BaselineVariance } from './baseline-overlay';
import { barBox, overlayAxis, overlayRows, slippedItems } from './overlay-rows';

const v = (from: string | null, to: string | null, deltaDays: number | null) => ({ from, to, deltaDays });
const snapshot = { goLive: null, milestones: [], deliverables: [], budgetedAmount: null, budgetedHours: null, budgetCurrency: null, scopeStatement: null };

const comparison: BaselineComparison = {
  from: { id: 'b1', projectId: 'p1', version: 1, changeRequestId: null, changeRequestCode: null, changeRequestTitle: null, snapshot, createdBy: 'u1', createdAt: '2026-11-01T00:00:00.000Z' },
  to: null,
  toSnapshot: snapshot,
  diff: {
    goLive: v('2026-12-01T00:00:00.000Z', '2026-12-09T00:00:00.000Z', 8),
    milestones: [
      { id: 'm1', name: 'Alpha', change: 'unchanged', ...v('2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', 0) },
      { id: 'm2', name: 'Beta', change: 'moved', ...v('2026-11-20T00:00:00.000Z', '2026-11-28T00:00:00.000Z', 8) },
    ],
    deliverables: [{ id: 'd1', number: 1, title: 'App', change: 'moved', start: v(null, null, null), end: v('2026-11-15T00:00:00.000Z', '2026-11-22T00:00:00.000Z', 7) }],
    budget: { from: '12000.00', to: '20000.00', delta: '8000.00' },
    hours: { from: null, to: null, delta: null },
  },
  pending: [
    { changeRequestId: 'pcr_1', code: 'CR-2', title: 'Move beta again', status: 'awaiting_approval', milestones: [{ milestoneId: 'm2', name: 'Beta', from: '2026-11-28T00:00:00.000Z', to: '2026-12-05T00:00:00.000Z' }], deliverables: [], goLive: null },
  ],
};

describe('overlay rows', () => {
  it('lists go-live, milestones and deliverables with their slip and pending previews', () => {
    const rows = overlayRows(comparison, 'Go-live');
    expect(rows.map((row) => [row.id, row.kind, row.deltaDays, row.pendingEnd])).toEqual([
      ['go-live', 'go_live', 8, null],
      ['m1', 'milestone', 0, null],
      ['m2', 'milestone', 8, '2026-12-05T00:00:00.000Z'],
      ['d1', 'deliverable', 7, null],
    ]);
    expect(slippedItems(rows)).toBe(2);
  });

  it('places bars on one axis', () => {
    const axis = overlayAxis(overlayRows(comparison, 'Go-live'));
    expect(axis).not.toBeNull();
    const early = barBox(axis!, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
    const late = barBox(axis!, '2026-12-09T00:00:00.000Z', '2026-12-09T00:00:00.000Z');
    expect(early!.left).toBeLessThan(late!.left);
    expect(barBox(axis!, null, null)).toBeNull();
  });
});

describe('BaselineVariance', () => {
  it('shows slip labels, the original date of a moved item and the KPI strip', () => {
    render(<BaselineVariance comparison={comparison} currency="EUR" />);
    expect(screen.getAllByTestId('slip-label').map((node) => node.textContent)).toEqual(['+8d', '+8d', '+7d']);
    expect(screen.getByText(/^Agreed .*Nov.*20.*2026$/)).toBeTruthy();
    expect(screen.getByText('Items slipped').nextElementSibling?.textContent).toBe('2');
    expect(screen.getByText('Pending changes').nextElementSibling?.textContent).toBe('1');
    expect(screen.getByText('Pending change CR-2: Move beta again')).toBeTruthy();
  });
});

describe('BaselineOverlay sign-off', () => {
  it('offers the sign-off to managers while there is no baseline, and only the hint to others', () => {
    const { unmount } = render(<BaselineOverlay projectId="p1" currency="EUR" canManage />);
    expect(screen.getByRole('button', { name: 'Sign off baseline v1' })).toBeTruthy();
    unmount();
    render(<BaselineOverlay projectId="p1" currency="EUR" canManage={false} />);
    expect(screen.queryByRole('button', { name: 'Sign off baseline v1' })).toBeNull();
    expect(screen.getByText(en.flowApprovals.baseline.signOffHint)).toBeTruthy();
  });
});
