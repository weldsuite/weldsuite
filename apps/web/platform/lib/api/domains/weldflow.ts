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
  // Goals canvas blob — heterogeneous card objects rendered by the goals view.
  // Typed as `any[]` to match the consuming `GoalsData` interface.
  goals: any[];
}
