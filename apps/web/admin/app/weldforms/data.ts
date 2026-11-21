import '@tanstack/react-start/server-only';

import { requireAdmin } from '@/lib/auth';
import { readReportFilter } from '@/lib/weldforms';
import {
  FORM_LIST_LIMIT,
  REPORT_LIST_LIMIT,
  countReportsByStatus,
  formsPortalUrl,
  listHeldForms,
  listReports,
  listSuspendedForms,
} from '@/lib/weldforms-data';

export type WeldFormsSearchParams = Record<string, string | string[] | undefined>;

/** Abuse reports for the status filter, the held forms and the suspended forms. */
export async function loadWeldFormsPage(searchParams: WeldFormsSearchParams) {
  const identity = await requireAdmin();
  const status = readReportFilter(searchParams.status);
  const canWrite = identity.role !== 'viewer';

  const [reports, counts, held, suspended] = await Promise.all([
    listReports(status),
    countReportsByStatus(),
    listHeldForms(),
    listSuspendedForms(),
  ]);

  return {
    status,
    canWrite,
    reports,
    counts,
    held,
    suspended,
    portalUrl: formsPortalUrl(),
    reportListLimit: REPORT_LIST_LIMIT,
    formListLimit: FORM_LIST_LIMIT,
  };
}

export type WeldFormsPageData = NonNullable<Awaited<ReturnType<typeof loadWeldFormsPage>>>;
