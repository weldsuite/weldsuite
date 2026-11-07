import type { MergeRecordLinkDto } from '@weldsuite/app-api-client/schemas/weldmerge';

/** `90` becomes `1h 30m`, `45` becomes `45m`, `0` becomes `0m`. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Hours and minutes typed as `1.5` hours or `90` minutes, as whole minutes; 0 when it is not a positive number. */
export function toMinutes(value: string, unit: 'minutes' | 'hours'): number {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(unit === 'hours' ? parsed * 60 : parsed);
}

export interface IssueCustomer {
  companyId: string;
  /** Cached label of the link, when the company was linked directly. */
  title: string | null;
  /** The ticket it came through; null for a direct link. */
  viaTicket: { id: string; title: string | null } | null;
}

/**
 * The companies an issue touches: those linked to it directly, and those the
 * issue's tickets belong to (`ticketCompanies` maps a ticket id to its company).
 * Each company appears once; a direct link wins over a ticket.
 */
export function collectIssueCustomers(
  links: readonly MergeRecordLinkDto[],
  ticketCompanies: ReadonlyMap<string, string | null>,
): IssueCustomer[] {
  const byCompany = new Map<string, IssueCustomer>();
  for (const link of links) {
    if (link.recordType === 'crm_company') {
      byCompany.set(link.recordId, { companyId: link.recordId, title: link.title, viaTicket: null });
    }
  }
  for (const link of links) {
    if (link.recordType !== 'desk_ticket') continue;
    const companyId = ticketCompanies.get(link.recordId);
    if (!companyId || byCompany.has(companyId)) continue;
    byCompany.set(companyId, { companyId, title: null, viaTicket: { id: link.recordId, title: link.title } });
  }
  return [...byCompany.values()];
}
