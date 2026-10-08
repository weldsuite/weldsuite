import { useCallback, useMemo, useState } from 'react';
import type { ReportQuery } from '@/lib/weldbooks/report-types';
import { applyParamsPatch, EMPTY_REPORT_PARAMS, toReportQuery, type ReportParams } from './report-model';

/**
 * The toolbar state of a report page and the request it stands for. Dates and
 * the basis start empty so the server answers with the entity's fiscal year
 * and accounting method; the toolbar shows what came back.
 */
export function useReportParams(initial: Partial<ReportParams> = {}) {
  const [params, setParams] = useState<ReportParams>({ ...EMPTY_REPORT_PARAMS, ...initial });
  const update = useCallback((patch: Partial<ReportParams>) => setParams((current) => applyParamsPatch(current, patch)), []);
  const query: ReportQuery = useMemo(() => toReportQuery(params), [params]);
  return { params, update, query };
}
