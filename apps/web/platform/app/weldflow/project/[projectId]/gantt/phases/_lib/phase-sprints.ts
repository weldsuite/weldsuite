/**
 * Sprints inside phases (a hybrid project) and the forecast for the phase
 * that is running: pure, so the timeline and its tests share it.
 */

import { dayNumber, todayNumber } from '@/app/weldflow/lib/sprint-metrics';

interface PhaseRange {
  id: string;
  plannedStart: string | null;
  plannedEnd: string | null;
}

interface SprintDates {
  id: string;
  startDate: string | null;
  endDate: string | null;
}

export interface PlacedSprints<S extends SprintDates> {
  /** Phase id to the sprints that start inside its planned range, in the order given. */
  byPhase: Map<string, S[]>;
  /** Sprints without dates, or starting outside every phase. */
  unplaced: S[];
}

/**
 * Each sprint goes in the phase whose planned range holds its start date (a
 * sprint with only an end date uses that). A phase without both dates holds
 * none; where ranges overlap, the first phase in the lifecycle wins.
 */
export function placeSprintsInPhases<S extends SprintDates>(phases: readonly PhaseRange[], sprints: readonly S[]): PlacedSprints<S> {
  const byPhase = new Map<string, S[]>(phases.map((phase) => [phase.id, []]));
  const unplaced: S[] = [];
  for (const sprint of sprints) {
    const day = dayNumber(sprint.startDate) ?? dayNumber(sprint.endDate);
    const phase =
      day === null
        ? undefined
        : phases.find((candidate) => {
            const start = dayNumber(candidate.plannedStart);
            const end = dayNumber(candidate.plannedEnd);
            return start !== null && end !== null && day >= start && day <= end;
          });
    if (phase) byPhase.get(phase.id)?.push(sprint);
    else unplaced.push(sprint);
  }
  return { byPhase, unplaced };
}

export type ForecastState = 'done' | 'onPlan' | 'late' | 'unknown';

export interface PhaseForecast {
  state: ForecastState;
  /** Sprints still needed, counting the one that runs now. */
  sprintsLeft: number;
  /** Day number the open work is likely done; null when it cannot be told. */
  finishDay: number | null;
  /** Sprints needed beyond the phase's end date; 0 unless late. */
  lateBySprints: number;
}

export interface ForecastInput {
  /** Story points still open in the backlog. */
  openPoints: number;
  /** Points per sprint: the average velocity; null or 0 when no sprint has completed. */
  velocity: number | null;
  sprintLengthDays: number;
  /** End date of the running sprint, when there is one: it is the first sprint of the work left. */
  activeSprintEnd: string | null;
  phaseEnd: string | null;
  today?: number;
}

/**
 * Open points divided by velocity gives the sprints left; the first of them
 * ends with the running sprint (else it starts today) and each next one takes
 * a sprint length. On plan when that date is within the phase's planned end.
 */
export function forecastPhase(input: ForecastInput): PhaseForecast {
  const { openPoints, velocity, sprintLengthDays, activeSprintEnd, phaseEnd } = input;
  const today = input.today ?? todayNumber();
  if (openPoints <= 0) return { state: 'done', sprintsLeft: 0, finishDay: today, lateBySprints: 0 };
  if (!velocity || velocity <= 0) return { state: 'unknown', sprintsLeft: 0, finishDay: null, lateBySprints: 0 };

  const sprintsLeft = Math.ceil(openPoints / velocity);
  const activeEnd = dayNumber(activeSprintEnd);
  const length = Math.max(1, sprintLengthDays);
  const firstEnd = activeEnd !== null && activeEnd >= today ? activeEnd : today + length;
  const finishDay = firstEnd + (sprintsLeft - 1) * length;

  const end = dayNumber(phaseEnd);
  if (end === null) return { state: 'onPlan', sprintsLeft, finishDay, lateBySprints: 0 };
  if (finishDay <= end) return { state: 'onPlan', sprintsLeft, finishDay, lateBySprints: 0 };
  return { state: 'late', sprintsLeft, finishDay, lateBySprints: Math.ceil((finishDay - end) / length) };
}

/** The sprints that still fit between now and the phase's end: capacity for the forecast's "x of y" line. */
export function sprintsOfCapacityLeft(input: Pick<ForecastInput, 'sprintLengthDays' | 'activeSprintEnd' | 'phaseEnd' | 'today'>): number | null {
  const end = dayNumber(input.phaseEnd);
  if (end === null) return null;
  const today = input.today ?? todayNumber();
  const length = Math.max(1, input.sprintLengthDays);
  const activeEnd = dayNumber(input.activeSprintEnd);
  const firstEnd = activeEnd !== null && activeEnd >= today ? activeEnd : today + length;
  if (firstEnd > end) return 0;
  return 1 + Math.floor((end - firstEnd) / length);
}
