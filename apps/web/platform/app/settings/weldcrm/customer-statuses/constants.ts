/**
 * Built-in customer status options — the five locked statuses every workspace
 * starts with. Custom statuses (workspace-defined) live alongside these in the
 * `crm_customer_statuses` table; the settings page renders both lists.
 *
 * Moved here from the now-retired `app/weldcrm/customers/lib/constants.ts`
 * during the Companies/People migration so the settings surface can stay
 * alive while the customer pages are removed.
 */

export const CUSTOMER_STATUS_OPTIONS: Array<{
  value: string;
  label: string;
  color: string;
}> = [
  { value: 'prospect', label: 'Prospect', color: 'blue' },
  { value: 'active', label: 'Active', color: 'green' },
  { value: 'inactive', label: 'Inactive', color: 'gray' },
  { value: 'churned', label: 'Churned', color: 'red' },
  { value: 'blacklisted', label: 'Blacklisted', color: 'zinc' },
];
