/**
 * The pure maths behind the sprint screens: which sprint the Pipeline opens
 * on, how sprints group in the picker, the numbers of Analytics > Sprints.
 */

import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a `YYYY-MM-DD` date or the date part of an ISO timestamp; null when it is not one. */
export function dayNumber(date: string | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

/** Today as a day number, in UTC like the sprint dates. */
export function todayNumber(now: Date = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY_MS);
}

function byStart(a: Sprint, b: Sprint): number {
  const left = dayNumber(a.startDate) ?? Number.POSITIVE_INFINITY;
  const right = dayNumber(b.startDate) ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.createdAt.localeCompare(b.createdAt);
}

/** Most recently completed first. */
function byCompletion(a: Sprint, b: Sprint): number {
  return (b.completedAt ?? b.endDate ?? '').localeCompare(a.completedAt ?? a.endDate ?? '');
}

export interface SprintGroups {
  active: Sprint | null;
  /** Soonest first. */
  planned: Sprint[];
  /** Most recent first. */
  past: Sprint[];
}

/** The sprints as the picker lists them: the running one, the planned ones, the past ones. */
export function groupSprints(sprints: readonly Sprint[]): SprintGroups {
  return {
    active: sprints.find((sprint) => sprint.status === 'active') ?? null,
    planned: sprints.filter((sprint) => sprint.status === 'planned').sort(byStart),
    past: sprints.filter((sprint) => sprint.status === 'completed' || sprint.status === 'cancelled').sort(byCompletion),
  };
}

/** The sprint the Pipeline opens on: the active one, else the next planned one, else none (all open work). */
export function defaultSprintId(sprints: readonly Sprint[]): string | null {
  const { active, planned } = groupSprints(sprints);
  return active?.id ?? planned[0]?.id ?? null;
}

/** Which day of the sprint it is (1-based) of how many; null without dates. */
export function sprintDay(
  sprint: Pick<Sprint, 'startDate' | 'endDate'>,
  today: number = todayNumber(),
): { day: number; total: number } | null {
  const start = dayNumber(sprint.startDate);
  const end = dayNumber(sprint.endDate);
  if (start === null || end === null || end < start) return null;
  const total = end - start + 1;
  return { day: Math.min(Math.max(today - start + 1, 1), total), total };
}

// -- Analytics > Sprints ------------------------------------------------------

/** A sprint's committed and completed points: the frozen report when there is one, else the sprint's own columns. */
export function sprintPoints(sprint: Sprint): { committed: number; completed: number } {
  return {
    committed: sprint.report?.committed?.points ?? sprint.storyPointsCommitted ?? 0,
    completed: sprint.report?.completed?.points ?? sprint.storyPointsCompleted ?? sprint.velocity ?? 0,
  };
}

/** Completed sprints, oldest first. */
export function completedSprints(sprints: readonly Sprint[]): Sprint[] {
  return sprints.filter((sprint) => sprint.status === 'completed').sort((a, b) => byCompletion(b, a));
}

export interface VelocityBar {
  id: string;
  name: string;
  committed: number;
  completed: number;
}

/** The last `limit` completed sprints, oldest first, for the velocity chart. */
export function velocityBars(sprints: readonly Sprint[], limit = 8): VelocityBar[] {
  return completedSprints(sprints)
    .slice(-limit)
    .map((sprint) => ({ id: sprint.id, name: sprint.name, ...sprintPoints(sprint) }));
}

export interface SprintKpis {
  /** Mean velocity of the last `window` completed sprints; null without any. */
  averageVelocity: number | null;
  lastVelocity: number | null;
  /** Completed of committed points over the window, in percent; null without committed points. */
  reliability: number | null;
  /** Items carried over per sprint over the window; null without any completed sprint. */
  carriedOver: number | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function sprintKpis(sprints: readonly Sprint[], window = 3): SprintKpis {
  const recent = completedSprints(sprints).slice(-window);
  if (recent.length === 0) return { averageVelocity: null, lastVelocity: null, reliability: null, carriedOver: null };
  const points = recent.map(sprintPoints);
  const committed = points.reduce((sum, p) => sum + p.committed, 0);
  const completed = points.reduce((sum, p) => sum + p.completed, 0);
  const carried = recent.reduce((sum, sprint) => sum + (sprint.report?.carriedOver?.count ?? 0), 0);
  const last = recent[recent.length - 1];
  return {
    averageVelocity: Math.round(completed / recent.length),
    lastVelocity: last.velocity ?? sprintPoints(last).completed,
    reliability: committed > 0 ? Math.round((completed / committed) * 100) : null,
    carriedOver: round1(carried / recent.length),
  };
}
