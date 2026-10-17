import type { ChipTone } from '@/components/accounting/weldbooks-row-cells';
import type { AgencyStatus } from '@/lib/api/domains/weldbooks-sales-tax-setup';

/** The tone of an agency's status chip: registered is green, a closed registration grey. */
export const AGENCY_STATUS_TONE: Record<AgencyStatus, ChipTone> = {
  registered: 'green',
  pending: 'amber',
  monitoring: 'blue',
  closed: 'gray',
};

/** What the member may change on an agency's jurisdictions, zones and rules. */
export interface AgencyTabAccess {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}
