import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HrSelfCoachingLog, HrSelfEvaluation, HrSelfPerformance } from '@weldsuite/app-api-client/domains/weldhr';

interface Query<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
}

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

let evaluationsQuery: Query<HrSelfEvaluation[]>;
let coachingQuery: Query<HrSelfCoachingLog[]>;
let performanceQuery: Query<HrSelfPerformance>;

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock('@/hooks/use-workspace-url', () => ({
  useWorkspaceUrl: () => (path: string) => `https://app.test/w/acme${path}`,
}));
vi.mock('@/hooks/queries/use-weldhr-queries', () => ({
  useMyHrEvaluations: () => ({ ...evaluationsQuery, refetch: mocks.refetch }),
  useMyHrCoaching: () => ({ ...coachingQuery, refetch: mocks.refetch }),
  useMyHrPerformance: () => ({ ...performanceQuery, refetch: mocks.refetch }),
}));
vi.mock('@/app/weldhr/me/components/acknowledge-dialog', () => ({
  AcknowledgeDialog: ({ target, onClose }: { target: { kind: string; id: string }; onClose: () => void }) => (
    <div role="dialog">
      <p>{`acknowledging ${target.kind} ${target.id}`}</p>
      <button type="button" onClick={onClose}>
        Close dialog
      </button>
    </div>
  ),
}));

import { MyCoachingPanel, MyEvaluationPanel, MyKpiPanel, MyMilestonePanel } from './my-review-panels';
import { renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function evaluation(extra: Partial<HrSelfEvaluation> = {}): HrSelfEvaluation {
  return {
    id: 'ev_1',
    formName: 'Q4 review',
    periodStart: '2026-10-01',
    periodEnd: '2026-12-31',
    criteria: [
      { id: 'c1', label: 'Quality', weight: 1, maxScore: 10 },
      { id: 'c2', label: 'Teamwork', weight: 1, maxScore: 10 },
      { id: 'c3', label: 'Broken', weight: 1, maxScore: 0 },
    ],
    scores: [
      { criterionId: 'c1', score: 8, comment: 'Very solid' },
      { criterionId: 'c3', score: 5 },
    ],
    overallScore: 82.5,
    summary: 'A strong quarter.',
    status: 'submitted',
    evaluatorName: 'Maria Manager',
    submittedAt: '2026-12-20',
    acknowledgedAt: null,
    employeeComment: null,
    ...extra,
  };
}

function coaching(extra: Partial<HrSelfCoachingLog> = {}): HrSelfCoachingLog {
  return {
    id: 'co_1',
    sessionDate: '2026-11-10',
    category: 'development',
    topic: 'Growing into lead',
    notes: 'Talked about next steps.',
    actionItems: [
      { id: 'a1', text: 'Read the book', done: true },
      { id: 'a2', text: 'Shadow a lead', done: false },
    ],
    followUpDate: '2026-12-01',
    status: 'open',
    coachName: 'Carl Coach',
    acknowledgedAt: null,
    employeeComment: null,
    ...extra,
  };
}

type KpiResult = HrSelfPerformance['kpis'][number];
type Milestone = HrSelfPerformance['milestones'][number];

function kpiResult(extra: Partial<KpiResult> = {}): KpiResult {
  return {
    id: 'res_1',
    kpiId: 'kpi_1',
    kpiName: 'Tickets closed',
    unit: 'number',
    direction: 'higher_better',
    target: 50,
    value: 60,
    onTarget: true,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    ...extra,
  };
}

function milestone(extra: Partial<Milestone> = {}): Milestone {
  return {
    id: 'ms_1',
    title: 'AWS certified',
    description: 'Pass the exam.',
    type: 'certification',
    status: 'in_progress',
    dueDate: '2026-12-15',
    achievedAt: '2026-12-10',
    companyName: 'Globex',
    ...extra,
  };
}

function loaded<T>(data: T): Query<T> {
  return { data, isLoading: false, error: null };
}

beforeEach(() => {
  mocks.refetch.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  evaluationsQuery = loaded([evaluation()]);
  coachingQuery = loaded([coaching()]);
  performanceQuery = loaded({ kpis: [kpiResult()], milestones: [milestone()] });
});

function renderEvaluation(id = 'ev_1') {
  return renderWithProviders(
    <MyEvaluationPanel id={id} isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}
function renderCoaching(id = 'co_1') {
  return renderWithProviders(
    <MyCoachingPanel id={id} isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}
function renderKpi(props: { id?: string; initialTab?: string } = {}) {
  return renderWithProviders(
    <MyKpiPanel
      id={props.id ?? 'kpi_1'}
      initialTab={props.initialTab}
      isOpen
      onClose={vi.fn()}
      mode="fullscreen"
      onModeChange={vi.fn()}
    />,
  );
}
function renderMilestone(id = 'ms_1') {
  return renderWithProviders(
    <MyMilestonePanel id={id} isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}

function setClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('MyEvaluationPanel', () => {
  it('shows the evaluation with its scores per criterion and the summary', () => {
    renderEvaluation();

    expect(screen.getAllByText('Q4 review').length).toBeGreaterThan(0);
    expect(screen.getByText('Maria Manager')).toBeInTheDocument();
    expect(screen.getByText('82.5')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.getByText('8 / 10')).toBeInTheDocument();
    expect(screen.getByText('Very solid')).toBeInTheDocument();
    // An unscored criterion shows a dash.
    expect(screen.getByText('— / 10')).toBeInTheDocument();
    expect(screen.getByText('5 / 0')).toBeInTheDocument();
    expect(screen.getByText('A strong quarter.')).toBeInTheDocument();
    expect(screen.queryByText('Your comment')).not.toBeInTheDocument();
  });

  it('shows what you acknowledged and your comment, and offers no acknowledge', async () => {
    evaluationsQuery = loaded([
      evaluation({
        status: 'acknowledged',
        acknowledgedAt: '2026-12-22',
        employeeComment: 'Thanks!',
      }),
    ]);
    const user = userEvent.setup();
    renderEvaluation();

    expect(screen.getByText('Thanks!')).toBeInTheDocument();
    expect(screen.getByText('Your comment')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('leaves out what the evaluation does not have', () => {
    evaluationsQuery = loaded([
      evaluation({
        formName: null,
        criteria: [],
        summary: null,
        overallScore: null,
        evaluatorName: null,
        submittedAt: null,
        status: 'draft',
      }),
    ]);
    renderEvaluation();

    expect(screen.getAllByText('Evaluation').length).toBeGreaterThan(0);
    expect(screen.queryByText('Scores')).not.toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
  });

  it('acknowledges from the menu', async () => {
    const user = userEvent.setup();
    renderEvaluation();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Acknowledge' }));
    expect(screen.getByText('acknowledging evaluation ev_1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('copies a link to the panel, and says so when it could not', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    setClipboard(writeText);
    renderEvaluation();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('?stack=hr_my_evaluation:ev_1'));
    expect(mocks.toastSuccess).toHaveBeenCalled();

    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it('says the evaluation is gone when it is not in the list', () => {
    renderEvaluation('ev_other');
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('shows placeholders while it loads and nothing else', () => {
    evaluationsQuery = { data: undefined, isLoading: true, error: null };
    const { container } = renderEvaluation();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the failure with a retry', async () => {
    evaluationsQuery = {
      data: undefined,
      isLoading: false,
      error: new Error('Server unavailable'),
    };
    const user = userEvent.setup();
    renderEvaluation();

    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});

describe('MyCoachingPanel', () => {
  it('shows the session with its notes and action items', () => {
    renderCoaching();

    expect(screen.getAllByText('Growing into lead').length).toBeGreaterThan(0);
    expect(screen.getByText('Development')).toBeInTheDocument();
    expect(screen.getByText('Carl Coach')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Talked about next steps.')).toBeInTheDocument();
    expect(screen.getByText('Read the book')).toHaveClass('line-through');
    expect(screen.getByText('Shadow a lead')).not.toHaveClass('line-through');
  });

  it('titles a session without a topic by its category and skips empty sections', () => {
    coachingQuery = loaded([
      coaching({
        topic: '',
        notes: null,
        actionItems: [],
        followUpDate: null,
        coachName: null,
      }),
    ]);
    renderCoaching();

    expect(screen.getAllByText('Development').length).toBeGreaterThan(1);
    expect(screen.queryByText('Notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Action items')).not.toBeInTheDocument();
  });

  it('shows your acknowledgement and offers no acknowledge', async () => {
    coachingQuery = loaded([
      coaching({
        status: 'acknowledged',
        acknowledgedAt: '2026-11-12',
        employeeComment: 'Noted',
      }),
    ]);
    const user = userEvent.setup();
    renderCoaching();

    expect(screen.getByText('Noted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('acknowledges from the menu', async () => {
    const user = userEvent.setup();
    renderCoaching();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Acknowledge' }));
    expect(screen.getByText('acknowledging coaching co_1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('handles a missing session and a failure', async () => {
    const user = userEvent.setup();
    const first = renderCoaching('co_other');
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    first.unmount();

    coachingQuery = {
      data: undefined,
      isLoading: false,
      error: new Error('Boom'),
    };
    renderCoaching();
    expect(screen.getByText('Boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});

describe('MyKpiPanel', () => {
  beforeEach(() => {
    performanceQuery = loaded({
      kpis: [
        kpiResult({
          id: 'res_old',
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
          value: 40,
          onTarget: false,
        }),
        kpiResult(),
        kpiResult({
          id: 'res_part',
          periodStart: '2026-10-05',
          periodEnd: '2026-10-20',
          value: 55,
          target: null,
          onTarget: null,
        }),
        kpiResult({ id: 'res_other', kpiId: 'kpi_2', kpiName: 'Other' }),
      ],
      milestones: [],
    });
  });

  it('shows the latest result on the Details tab', () => {
    renderKpi();

    expect(screen.getAllByText('Tickets closed').length).toBeGreaterThan(0);
    expect(screen.getByText('55')).toBeInTheDocument();
    expect(screen.getByText('No target set')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'History' })).toBeInTheDocument();
  });

  it('shows the target and an on-target pill when there is one', () => {
    performanceQuery = loaded({
      kpis: [kpiResult({ unit: 'percent', value: 91.26, target: 90 })],
      milestones: [],
    });
    renderKpi();

    expect(screen.getByText('91.3%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('On target')).toBeInTheDocument();
  });

  it('lists every result of the KPI, newest first, with whole months named', async () => {
    const user = userEvent.setup();
    renderKpi();

    await user.click(screen.getByRole('tab', { name: /History/ }));
    expect(screen.getByText('September 2026')).toBeInTheDocument();
    expect(screen.getByText('August 2026')).toBeInTheDocument();
    // A period that is not a whole month shows its dates.
    expect(screen.getByText(/5 Oct 2026 – 20 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText('Off target')).toBeInTheDocument();
    expect(screen.getByText('On target')).toBeInTheDocument();
    expect(screen.getByText('No target set')).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.getByText('Latest value')).toBeInTheDocument();
  });

  it('opens on the history tab when asked to', () => {
    renderKpi({ initialTab: 'history' });
    expect(screen.getByText('August 2026')).toBeInTheDocument();
  });

  it('says the KPI is gone, and shows a failure with a retry', async () => {
    const user = userEvent.setup();
    const first = renderKpi({ id: 'kpi_missing' });
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    first.unmount();

    performanceQuery = {
      data: undefined,
      isLoading: false,
      error: new Error('Down'),
    };
    renderKpi();
    expect(screen.getByText('Down')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('shows placeholders while loading', () => {
    performanceQuery = { data: undefined, isLoading: true, error: null };
    const { container } = renderKpi();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

describe('MyMilestonePanel', () => {
  it('shows the milestone with its dates, client and description', () => {
    renderMilestone();

    expect(screen.getAllByText('AWS certified').length).toBeGreaterThan(0);
    expect(screen.getByText('Certification')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('15 Dec 2026')).toBeInTheDocument();
    expect(screen.getByText('10 Dec 2026')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    expect(screen.getByText('Pass the exam.')).toBeInTheDocument();
  });

  it('leaves out the description and shows dashes for what is not set', () => {
    performanceQuery = loaded({
      kpis: [],
      milestones: [
        milestone({
          description: null,
          dueDate: null,
          achievedAt: null,
          companyName: null,
        }),
      ],
    });
    renderMilestone();

    expect(screen.queryByText('Description')).not.toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('copies a link from the menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    setClipboard(writeText);
    renderMilestone();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('?stack=hr_my_milestone:ms_1'));
  });

  it('says the milestone is gone, and shows a failure with a retry', async () => {
    const user = userEvent.setup();
    const first = renderMilestone('ms_missing');
    expect(screen.getByText('This item is no longer there.')).toBeInTheDocument();
    first.unmount();

    performanceQuery = {
      data: undefined,
      isLoading: false,
      error: new Error('Nope'),
    };
    renderMilestone();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Nope')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});
