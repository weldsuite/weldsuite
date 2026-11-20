/**
 * The report a builder page was opened with (`?report=<id>`): loads it once,
 * hands its spec to the page to turn into a draft, and says when the report is
 * of another kind (a funnel opened on Insights).
 */

import { useEffect, useState } from 'react';
import type { PanelDateRange } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { useWeldPanelReport } from '@/hooks/queries/use-weldpanel-queries';
import { useRouter, useSearchParams } from '@/lib/router';
import { REPORT_BUILDER_PATHS } from '../lib/links';
import { useCurrentProject } from '../lib/use-current-project';

interface UseSavedReportOptions {
  kind: PanelReportDto['kind'];
  /** Turn the saved spec into the page's state; return false when the spec no longer parses. */
  apply: (spec: Record<string, unknown>, range: PanelDateRange | undefined) => boolean;
}

export interface SavedReportState {
  reportId: string;
  report: PanelReportDto | undefined;
  isLoading: boolean;
  isError: boolean;
  /** The id belongs to a report of another kind; open it from this page instead. */
  wrongKindPath: string | null;
  /** The stored spec could not be read back. */
  invalid: boolean;
  /** Point the URL at a (newly saved) report. */
  open: (report: PanelReportDto) => void;
}

/**
 * The report applied while its own project was current. Builders remount when the project
 * changes, so this lives outside the component: a remount that finds the project no longer
 * matches means the user switched away on purpose. It is forgotten once the page is left.
 */
let settledReportId: string | null = null;
let forgetTimer: ReturnType<typeof setTimeout> | undefined;

export function useSavedReport({ kind, apply }: UseSavedReportOptions): SavedReportState {
  const params = useSearchParams();
  const router = useRouter();
  const reportId = params.get('report') ?? '';
  const { data: report, isLoading, isError } = useWeldPanelReport(reportId);
  const [invalid, setInvalid] = useState(false);

  // A remount cancels the pending forget; leaving the page lets it run.
  useEffect(() => {
    clearTimeout(forgetTimer);
    return () => {
      forgetTimer = setTimeout(() => {
        settledReportId = null;
      }, 0);
    };
  }, []);
  const { select, project } = useCurrentProject();

  useEffect(() => {
    if (!report || report.kind !== kind) return;
    // Applied before and the user has since moved to another project: leave the report, or the
    // link would pull them straight back.
    if (settledReportId === report.id && project && project.id !== report.projectId) {
      settledReportId = null;
      router.replace(REPORT_BUILDER_PATHS[kind]);
      return;
    }
    if (project?.id === report.projectId) settledReportId = report.id;
    const spec = report.spec;
    const range = spec.dateRange as PanelDateRange | undefined;
    setInvalid(!apply(spec, range));
    // A link to a report of another project switches to that project.
    select(report.projectId);
    // `apply` and `select` only set state; applying once per report is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, kind]);

  return {
    reportId,
    report,
    isLoading: reportId !== '' && isLoading,
    isError: reportId !== '' && isError,
    wrongKindPath: report && report.kind !== kind ? (REPORT_BUILDER_PATHS[report.kind] ?? null) : null,
    invalid,
    open: (saved) => router.replace(`${REPORT_BUILDER_PATHS[kind]}?report=${encodeURIComponent(saved.id)}`),
  };
}
