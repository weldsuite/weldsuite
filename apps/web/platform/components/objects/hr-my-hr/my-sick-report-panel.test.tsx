import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfAbsence, HrSelfAbsences } from '@weldsuite/app-api-client/domains/weldhr';

const mocks = vi.hoisted(() => ({ refetch: vi.fn() }));
let queryState: 'loaded' | 'loading' | 'failed' = 'loaded';
let absences: HrSelfAbsences;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test${path}`,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrAbsences: () => ({
    data: queryState === 'loaded' ? absences : undefined,
    isLoading: queryState === 'loading',
    error: queryState === 'failed' ? new Error('Server unavailable') : null,
    refetch: mocks.refetch,
  }),
}));
// The dialog has its own tests.
vi.mock('@/app/weldhr/absenteeism/components/recover-dialog', () => ({
  RecoverDialog: ({ absence, self, onClose }: { absence: { id: string }; self?: boolean; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      {`Recover dialog ${absence.id} ${self ? 'self' : 'other'}`}
    </button>
  ),
}));

import { MySickReportPanel } from './my-sick-report-panel';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function makeAbsence(extra: Partial<HrSelfAbsence> = {}): HrSelfAbsence {
  return {
    id: 'abs_1',
    startDate: '2026-03-02',
    endDate: null,
    firstDay: 'full',
    note: 'Flu',
    status: 'ongoing',
    days: 3,
    createdAt: '2026-03-02T08:00:00Z',
    ...extra,
  };
}

function renderPanel(id = 'abs_1') {
  return renderWithProviders(<MySickReportPanel id={id} isOpen onClose={() => {}} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryState = 'loaded';
  absences = { current: makeAbsence(), history: [] };
});

describe('MySickReportPanel', () => {
  it('shows the open report as still absent, with its note', () => {
    renderPanel();
    expect(screen.getByText('Flu')).toBeInTheDocument();
    expect(screen.getByText('Still absent')).toBeInTheDocument();
  });

  it('shows a closed report from the history, with no recover action', async () => {
    absences = {
      current: null,
      history: [
        makeAbsence({
          id: 'abs_old',
          endDate: '2026-02-04',
          note: null,
          status: 'completed',
        }),
      ],
    };
    renderPanel('abs_old');
    expect(screen.queryByText('Still absent')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /more actions/i }));
    expect(await screen.findByRole('menuitem', { name: /copy link/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Report recovered' })).not.toBeInTheDocument();
  });

  it('opens the recover dialog for the open report and closes it again', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Report recovered' }));
    await user.click(await screen.findByRole('button', { name: 'Recover dialog abs_1 self' }));
    expect(screen.queryByRole('button', { name: /Recover dialog/ })).not.toBeInTheDocument();
  });

  it('says so when the report is not in the list', () => {
    renderPanel('abs_unknown');
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
  });

  it('shows the error with Try again when the list failed', async () => {
    queryState = 'failed';
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows nothing of the report while loading', () => {
    queryState = 'loading';
    renderPanel();
    expect(screen.queryByText('Flu')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
