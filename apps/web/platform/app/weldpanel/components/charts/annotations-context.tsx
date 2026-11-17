/**
 * Whether time charts show annotations, and whose. The WeldPanel layout turns
 * them on (`enabled`) for every page of the module; a dashboard tile narrows
 * them to its report. Without an enabling provider above (the public share
 * page, a test rendering a view on its own) charts draw no markers and make
 * no request.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface ChartAnnotationsScope {
  /** The project; left out: the current project. */
  projectId?: string;
  /**
   * The report whose own annotations show next to the project-wide ones.
   * Left out: the builder's `?report=` (if any); null: project-wide only.
   */
  reportId?: string | null;
}

const ChartAnnotationsContext = createContext<ChartAnnotationsScope | null>(null);

interface ChartAnnotationsProviderProps extends ChartAnnotationsScope {
  /** Turns annotations on below. Without it a provider only narrows what a parent turned on. */
  enabled?: boolean;
  /** Turns them off below (a preview chart inside a dialog). */
  disabled?: boolean;
  children: ReactNode;
}

export function ChartAnnotationsProvider({ enabled = false, disabled = false, projectId, reportId, children }: Readonly<ChartAnnotationsProviderProps>) {
  const parent = useContext(ChartAnnotationsContext);
  const value = useMemo<ChartAnnotationsScope | null>(() => {
    if (disabled || (!enabled && parent === null)) return null;
    const next: ChartAnnotationsScope = { ...parent };
    if (projectId !== undefined) next.projectId = projectId;
    if (reportId !== undefined) next.reportId = reportId;
    return next;
  }, [enabled, disabled, parent, projectId, reportId]);
  return <ChartAnnotationsContext.Provider value={value}>{children}</ChartAnnotationsContext.Provider>;
}

/** The scope charts read; null when annotations are off here. */
export function useChartAnnotationsScope(): ChartAnnotationsScope | null {
  return useContext(ChartAnnotationsContext);
}
