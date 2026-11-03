import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReportQuery } from '@/lib/weldbooks/report-types';
import { applyParamsPatch, EMPTY_REPORT_PARAMS, isReversedRange, toReportQuery, type ReportParams } from './report-model';

/**
 * The toolbar state of a report page and the request it stands for. Dates and
 * the basis start empty so the server answers with the entity's fiscal year
 * and accounting method; the toolbar shows what came back.
 *
 * While `from` is after `to` the request stays at the last valid one, so the
 * report on screen doesn't turn into an error; the toolbar says what to fix.
 */
export function useReportParams(initial: Partial<ReportParams> = {}) {
  const [params, setParams] = useState<ReportParams>({ ...EMPTY_REPORT_PARAMS, ...initial });
  const update = useCallback((patch: Partial<ReportParams>) => setParams((current) => applyParamsPatch(current, patch)), []);
  const lastValid = useRef<ReportQuery | null>(null);
  const query: ReportQuery = useMemo(() => {
    if (isReversedRange(params.from, params.to)) return lastValid.current ?? {};
    lastValid.current = toReportQuery(params);
    return lastValid.current;
  }, [params]);
  return { params, update, query };
}
