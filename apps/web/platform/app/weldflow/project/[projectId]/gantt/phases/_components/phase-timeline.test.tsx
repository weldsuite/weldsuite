import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { PhaseSummary } from '@weldsuite/app-api-client/domains/project-schedule';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';

const state = vi.hoisted(() => ({
  delivery: { available: true, usesPhases: true, usesSprints: true, settings: { sprintLengthDays: 14 } },
  sprints: { data: [] as unknown[] },
  backlog: { data: undefined as undefined | { open: number; total: number } },
}));

vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => state.delivery,
  useProjectSprints: () => state.sprints,
}));
vi.mock('@/hooks/queries/use-flow-agile-sprint-queries', () => ({ useOpenBacklogPoints: () => state.backlog }));

import { PhaseTimeline } from './phase-timeline';

function phase(id: string, status: PhaseSummary['status'], plannedStart: string | null, plannedEnd: string | null): PhaseSummary {
  return { id, name: `Phase ${id}`, status, plannedStart, plannedEnd } as PhaseSummary;
}

function sprint(id: string, status: string, startDate: string | null, endDate: string | null, extra: Partial<Sprint> = {}): Sprint {
  return {
    id,
    projectId: 'p1',
    name: `Sprint ${id}`,
    goal: null,
    status,
    startDate,
    endDate,
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

const done = sprint('1', 'completed', '2026-10-05', '2026-10-18', { velocity: 10, completedAt: '2026-10-18T10:00:00Z' });
const running = sprint('2', 'active', '2026-11-02', '2026-11-15');

function show(phases: PhaseSummary[]) {
  return render(
    <I18nProvider initialLanguage="en">
      <PhaseTimeline projectId="p1" phases={phases} />
    </I18nProvider>,
  );
}

const planPhases = [phase('A', 'passed', '2026-10-01', '2026-10-31'), phase('B', 'active', '2026-11-01', '2026-12-31'), phase('C', 'upcoming', null, null)];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  state.delivery = { available: true, usesPhases: true, usesSprints: true, settings: { sprintLengthDays: 14 } };
  state.sprints = { data: [done, running] };
  state.backlog = { data: { open: 15, total: 40 } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PhaseTimeline', () => {
  it('shows nothing where agile delivery is not available', () => {
    state.delivery = { ...state.delivery, available: false };
    const { container } = show(planPhases);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing for a project without sprint planning and without sprints', () => {
    state.delivery = { ...state.delivery, usesSprints: false };
    state.sprints = { data: [] };
    const { container } = show(planPhases);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows for a project without phases planning once it has sprints', () => {
    state.delivery = { ...state.delivery, usesPhases: false };
    show(planPhases);
    expect(screen.getByRole('heading', { name: 'Phases and sprints' })).toBeInTheDocument();
  });

  it('places each sprint in the phase that holds its start, with the phase dates and a today marker', () => {
    show(planPhases);
    const group = screen.getByRole('group', { name: 'Timeline of the phases with their sprints' });
    expect(within(group).getByText('Phase A')).toBeInTheDocument();
    expect(within(group).getByText('Phase C')).toBeInTheDocument();
    // The phase without planned dates says so.
    expect(within(group).getByText('No dates yet')).toBeInTheDocument();
    expect(within(group).getByText('Today')).toBeInTheDocument();

    const inA = within(group).getByRole('list', { name: 'Sprints in Phase A' });
    expect(within(inA).getByText('Sprint 1')).toBeInTheDocument();
    const inB = within(group).getByRole('list', { name: 'Sprints in Phase B' });
    expect(within(inB).getByText('Sprint 2')).toBeInTheDocument();
    expect(within(inB).getByTitle(/Sprint 2 · /)).toBeInTheDocument();
    expect(screen.queryByText(/have no dates or start outside/)).not.toBeInTheDocument();
  });

  it('forecasts the running phase: on plan, from the average velocity, with the points left', () => {
    show(planPhases);
    expect(screen.getByRole('heading', { name: 'Will Phase B finish on time?' })).toBeInTheDocument();
    expect(screen.getByText('On plan')).toBeInTheDocument();
    expect(screen.getByText('Forecast from an average velocity of 10 pts per sprint')).toBeInTheDocument();
    expect(screen.getByText(/15 pts left · 4 sprints of capacity left/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/Likely done on .* after 2 more sprints\./)).toBeInTheDocument();
    expect(screen.queryByText(/That is after the planned end/)).not.toBeInTheDocument();
  });

  it('says when the work will be done after the end of the phase', () => {
    state.backlog = { data: { open: 100, total: 120 } };
    show(planPhases);
    expect(screen.getByText('Behind plan')).toBeInTheDocument();
    expect(screen.getByText(/after 10 more sprints\. That is after the planned end on .* It needs \d+ more sprints than the phase has\./)).toBeInTheDocument();
  });

  it('uses the singular for one sprint left and one sprint too many', () => {
    state.backlog = { data: { open: 5, total: 40 } };
    show([phase('B', 'active', '2026-11-01', '2026-11-12')]);
    expect(screen.getByText(/after one more sprint\. That is after the planned end on .* It needs one more sprint than the phase has\./)).toBeInTheDocument();
  });

  it('uses the singular for one sprint of capacity left', () => {
    state.backlog = { data: { open: 5, total: 40 } };
    show([phase('B', 'active', '2026-11-01', '2026-11-20')]);
    expect(screen.getByText(/5 pts left · 1 sprint of capacity left/)).toBeInTheDocument();
    expect(screen.getByText(/Likely done on .* after one more sprint.$/)).toBeInTheDocument();
  });

  it('asks for a completed sprint when there is no velocity yet', () => {
    state.sprints = { data: [running] };
    show(planPhases);
    expect(screen.getByText('No forecast yet')).toBeInTheDocument();
    expect(screen.getByText('Complete a sprint to get a forecast.')).toBeInTheDocument();
    expect(screen.queryByText(/Forecast from an average velocity/)).not.toBeInTheDocument();
  });

  it('says nothing is left when the backlog is done', () => {
    state.backlog = { data: { open: 0, total: 0 } };
    show(planPhases);
    expect(screen.getByText('Nothing left')).toBeInTheDocument();
    expect(screen.getByText('All the work in the backlog is done.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('has no forecast without a running phase or before the backlog loads', () => {
    show([phase('A', 'passed', '2026-10-01', '2026-10-31'), phase('B', 'upcoming', '2026-11-01', '2026-12-31')]);
    expect(screen.queryByText(/Will Phase/)).not.toBeInTheDocument();
  });

  it('has no forecast before the backlog loads', () => {
    state.backlog = { data: undefined };
    show(planPhases);
    expect(screen.queryByText(/Will Phase B finish on time/)).not.toBeInTheDocument();
  });

  it('forecasts without a capacity when the phase has no end date', () => {
    show([phase('B', 'active', '2026-11-01', null)]);
    expect(screen.getByText('15 pts left')).toBeInTheDocument();
    expect(screen.queryByText(/of capacity left/)).not.toBeInTheDocument();
    expect(screen.getByText(/Likely done on/)).toBeInTheDocument();
  });

  it('counts the sprints without dates or outside every phase, and leaves out cancelled ones', () => {
    state.sprints = {
      data: [
        done,
        running,
        sprint('3', 'planned', null, null),
        sprint('4', 'planned', '2027-03-01', null),
        sprint('5', 'cancelled', '2026-11-20', '2026-11-30'),
        sprint('6', 'planned', null, '2026-11-29'),
      ],
    };
    show(planPhases);
    expect(screen.getByText('2 sprints have no dates or start outside every phase')).toBeInTheDocument();
    // The sprint with only an end date sits in the phase of that date.
    const inB = screen.getByRole('list', { name: 'Sprints in Phase B' });
    expect(within(inB).getByText('Sprint 6')).toBeInTheDocument();
    expect(screen.queryByText('Sprint 5')).not.toBeInTheDocument();
  });

  it('uses the singular for one sprint outside every phase', () => {
    state.sprints = { data: [done, running, sprint('3', 'planned', null, null)] };
    show(planPhases);
    expect(screen.getByText('1 sprint has no dates or starts outside every phase')).toBeInTheDocument();
  });

  it('gives a sprint without an end date the length of a sprint, and shows planned sprints', () => {
    state.sprints = { data: [done, running, sprint('3', 'planned', '2026-11-16', null)] };
    show(planPhases);
    const inB = screen.getByRole('list', { name: 'Sprints in Phase B' });
    expect(within(inB).getByTitle(/Sprint 3 · /)).toBeInTheDocument();
  });

  it('asks for planned dates when no phase has any', () => {
    state.sprints = { data: [] };
    state.delivery = { ...state.delivery, usesPhases: true, usesSprints: true };
    show([phase('A', 'active', null, null)]);
    expect(screen.getByText(/The phases have no planned dates yet/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Timeline of the phases with their sprints' })).not.toBeInTheDocument();
  });

  it('shows a timeline when only the phases have dates and there are no sprints yet', () => {
    state.sprints = { data: [] };
    show(planPhases);
    expect(screen.getByRole('group', { name: 'Timeline of the phases with their sprints' })).toBeInTheDocument();
    expect(screen.getByText('No forecast yet')).toBeInTheDocument();
  });
});
