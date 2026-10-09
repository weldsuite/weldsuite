/**
 * Gusto: a thin client for the Embedded Payroll API (raw `fetch`, no SDK) and
 * the step from a processed payroll's totals to WeldBooks payroll totals.
 *
 * NOT LIVE-TESTED. The endpoints and the totals field names follow Gusto's
 * published API reference (`GET /v1/companies/{company_uuid}` and
 * `GET /v1/companies/{company_uuid}/payrolls?...&include=totals`) and are
 * covered by recorded-fixture tests only. Getting an access token for a
 * customer's company needs a Gusto partner application and its OAuth flow; until
 * that exists the customer supplies the access token themselves.
 *
 * The API version is pinned with `X-Gusto-API-Version`. Check it against
 * Gusto's current versions when the partner application is set up.
 */

import { emptyTotals, type PayrollTotals } from './journal';

export const GUSTO_API_VERSION = '2024-04-01';

export type GustoEnvironment = 'production' | 'demo';

export interface GustoCredentials {
  accessToken: string;
  environment: GustoEnvironment;
}

export function gustoBaseUrl(environment: GustoEnvironment): string {
  return environment === 'demo' ? 'https://api.gusto-demo.com' : 'https://api.gusto.com';
}

export class GustoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GustoApiError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function gustoGet(
  credentials: GustoCredentials,
  path: string,
  params: Record<string, string> = {},
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<unknown> {
  const url = new URL(path, gustoBaseUrl(credentials.environment));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: 'application/json',
      'X-Gusto-API-Version': GUSTO_API_VERSION,
    },
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 300);
    if (response.status === 401) throw new GustoApiError('Gusto rejected the access token (expired or revoked)', 401);
    if (response.status === 403) throw new GustoApiError('The Gusto access token does not allow reading this company or its payrolls', 403);
    if (response.status === 404) throw new GustoApiError('Gusto does not know this company id', 404);
    throw new GustoApiError(`Gusto answered ${response.status}${body ? `: ${body}` : ''}`, response.status);
  }
  return response.json();
}

export interface GustoCompany {
  id: string;
  name: string | null;
}

/** Verifies the token and the company id. */
export async function fetchGustoCompany(
  credentials: GustoCredentials,
  companyId: string,
  fetchImpl?: FetchLike,
): Promise<GustoCompany> {
  const body = (await gustoGet(credentials, `/v1/companies/${encodeURIComponent(companyId)}`, {}, fetchImpl)) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name : typeof body.trade_name === 'string' ? body.trade_name : null;
  const id = String(body.uuid ?? body.id ?? companyId);
  return { id, name };
}

/** The raw processed payrolls of a company between two check dates, with totals. */
export async function fetchProcessedPayrolls(
  credentials: GustoCredentials,
  companyId: string,
  range: { from: string; to: string },
  fetchImpl?: FetchLike,
): Promise<unknown[]> {
  const path = `/v1/companies/${encodeURIComponent(companyId)}/payrolls`;
  const all: unknown[] = [];
  const seen = new Set<string>();
  const perPage = 100;
  for (let page = 1; page <= 50; page++) {
    const body = await gustoGet(
      credentials,
      path,
      {
        // `processed` is the older spelling of `processing_statuses=processed`; both are sent.
        processed: 'true',
        processing_statuses: 'processed',
        include_off_cycle: 'true',
        start_date: range.from,
        end_date: range.to,
        include: 'totals',
        page: String(page),
        per: String(perPage),
      },
      fetchImpl,
    );
    const items = Array.isArray(body) ? body : [];
    let fresh = 0;
    for (const item of items) {
      const id = payrollIdOf(item) ?? JSON.stringify(item);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push(item);
      fresh += 1;
    }
    // A short or repeated page is the last one (an API that ignores `page` repeats the first).
    if (items.length < perPage || fresh === 0) break;
  }
  return all;
}

export function payrollIdOf(payroll: unknown): string | null {
  if (!payroll || typeof payroll !== 'object') return null;
  const record = payroll as Record<string, unknown>;
  const id = record.payroll_uuid ?? record.uuid ?? record.payroll_id ?? record.id;
  return id === undefined || id === null || id === '' ? null : String(id);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

export interface GustoPayroll {
  externalId: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  offCycle: boolean;
  totals: PayrollTotals;
}

/**
 * A processed payroll from the API as WeldBooks totals:
 *
 *   gross wages        totals.gross_pay
 *   employer taxes     totals.employer_taxes
 *   employer benefits  totals.benefits              (company contributions)
 *   reimbursements     totals.reimbursements
 *   owner's draw       totals.owners_draw
 *   employee taxes     totals.employee_taxes
 *   employee deductions totals.employee_benefits_deductions + totals.other_deductions
 *   net pay            totals.net_pay
 *
 * Returns the reason when the payroll cannot be used (not processed, no totals,
 * no check date).
 */
export function normalizeGustoPayroll(payroll: unknown): GustoPayroll | { skip: string; externalId: string | null } {
  const externalId = payrollIdOf(payroll);
  if (!externalId || typeof payroll !== 'object' || payroll === null) return { skip: 'The payroll has no id', externalId };
  const record = payroll as Record<string, unknown>;
  if (record.processed === false) return { skip: 'The payroll is not processed yet', externalId };
  const totals = record.totals as Record<string, unknown> | null | undefined;
  if (!totals || typeof totals !== 'object') return { skip: 'The payroll has no totals', externalId };
  const checkDate = String(record.check_date ?? record.pay_date ?? '');
  if (!ISO_DAY.test(checkDate)) return { skip: 'The payroll has no check date', externalId };

  const period = (record.pay_period ?? {}) as Record<string, unknown>;
  const day = (value: unknown): string | null => (typeof value === 'string' && ISO_DAY.test(value) ? value.slice(0, 10) : null);
  return {
    externalId,
    payDate: checkDate.slice(0, 10),
    periodStart: day(period.start_date),
    periodEnd: day(period.end_date),
    offCycle: record.off_cycle === true,
    totals: {
      ...emptyTotals(),
      grossWages: toNumber(totals.gross_pay),
      employerTaxes: toNumber(totals.employer_taxes),
      employerBenefits: toNumber(totals.benefits),
      reimbursements: toNumber(totals.reimbursements),
      ownersDraw: toNumber(totals.owners_draw),
      employeeTaxes: toNumber(totals.employee_taxes),
      employeeDeductions: toNumber(totals.employee_benefits_deductions) + toNumber(totals.other_deductions),
      netPay: toNumber(totals.net_pay),
    },
  };
}
