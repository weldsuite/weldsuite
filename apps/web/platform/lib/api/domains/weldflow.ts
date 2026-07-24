/**
 * WeldFlow Domain Types
 *
 * The legacy `projectsWorkerApi` and 600+ lines of API wrapper code that
 * lived here have been deleted as part of the WeldFlow → app-api migration.
 * All HTTP calls now go through `apps/web/platform/app/weldflow/lib/api-client.ts`
 * (centralized) or `apps/web/platform/hooks/queries/use-projects-queries.ts`
 * (TanStack hooks), both pointing at `apps/workers/app-api`.
 *
 * Only types still referenced by call sites are kept here.
 */

/**
 * A single goal card on the WeldFlow goals canvas. Mirrors the unexported
 * `GoalCardType` in `components/weldflow/goals/goals-canvas-view.tsx` — kept
 * structurally identical so `ProjectGoals` stays assignable to that
 * component's `GoalsData` prop without either side importing the other.
 */
export interface ProjectGoalCard {
  id: string;
  title: string;
  description?: string;
  owner: {
    name: string;
    avatar?: string;
    initials: string;
    color: string;
  };
  status: 'on-track' | 'at-risk' | 'off-track' | 'not-started' | 'completed';
  progress: number;
  dueDate: string | Date;
  timePeriod: string;
  type: 'company' | 'team' | 'individual';
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  subGoals?: string[];
  metrics?: {
    target: number;
    current: number;
    unit: string;
  };
  updates?: number;
  comments?: number;
  attachments?: number;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  linkedTaskId?: string;
}

export interface ProjectGoals {
  mission: {
    id: string;
    title: string;
    description: string;
    x: number;
    y: number;
    width: number;
    height: number;
    subGoals: string[];
  };
  goals: ProjectGoalCard[];
}
