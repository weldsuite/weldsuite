/**
 * WeldBooks time billing client (phase 6, Rust only: edition feature
 * `books-time-billing`): the billable WeldFlow time per customer and project
 * that is not invoiced yet, invoicing it once, and a project's finance. Shapes
 * mirror `rust/modules/books-sales/src/time_billing.rs`. Every answer is `{ data }`.
 */
import { weldbooksApi } from '../weldbooks-client';
import type { Invoice } from './weldbooks';

export interface DataEnvelope<T> {
  data: T;
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/** Where an entry's rate came from; `none` is billed at zero until a rate is set. */
export type RateSource = 'entry' | 'project' | 'member' | 'none';

export interface UnbilledEntry {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  userId: string;
  userName: string;
  description: string | null;
  activity: string | null;
  /** Decimal text, up to two decimals. */
  hours: string;
  rate: string;
  amount: string;
  rateSource: RateSource;
}

export interface UnbilledProject {
  projectId: string;
  name: string;
  hours: string;
  amount: string;
  entries: UnbilledEntry[];
}

/** A customer billed in two currencies appears once per currency. */
export interface UnbilledCustomer {
  customer: { contactId: string; name: string };
  hours: string;
  amount: string;
  currency: string;
  projects: UnbilledProject[];
}

export interface UnbilledParams {
  customerId?: string;
  projectId?: string;
  /** Only time up to and including this date (`YYYY-MM-DD`). */
  to?: string;
}

export const TIME_GROUPINGS = ['project', 'person', 'activity', 'entry'] as const;
export type TimeGrouping = (typeof TIME_GROUPINGS)[number];

export interface InvoiceFromTimeInput {
  /** 1 to 500. */
  timeEntryIds: string[];
  grouping: TimeGrouping;
  /** Appends to this draft of the same customer instead of making a new one. */
  invoiceId?: string;
  entityId?: string;
}

export interface TimeInvoiceItem {
  id: string;
  description: string;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  projectId?: string | null;
}

export type InvoiceFromTime = Invoice & { items?: TimeInvoiceItem[] };

/** An amount per currency. */
export interface FinanceAmount {
  currency: string;
  amount: string;
}

export interface ProjectFinance {
  projectId: string;
  invoiced: FinanceAmount[];
  draft: FinanceAmount[];
  /** Only for a member who may read time. */
  unbilled?: { hours: string; amount: FinanceAmount[] };
  /** Only for a member who may read bills. */
  costs?: FinanceAmount[];
}

export const timeBillingApi = {
  unbilled: (params: UnbilledParams = {}) =>
    weldbooksApi.get<DataEnvelope<UnbilledCustomer[]>>(`/accounting-time/unbilled${buildQuery({ ...params })}`),
  invoiceFromTime: (input: InvoiceFromTimeInput) =>
    weldbooksApi.post<DataEnvelope<InvoiceFromTime>>('/invoices/from-time', input),
  projectFinance: (projectId: string) =>
    weldbooksApi.get<DataEnvelope<ProjectFinance>>(`/accounting-projects/${encodeURIComponent(projectId)}/finance`),
};
