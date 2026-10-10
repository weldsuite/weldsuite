import { useHrPayrollFlag, useMyPayrollDetails, useMyPayslips } from '@/hooks/queries/use-weldhr-payroll-queries';
import { unsignedElections } from './payroll-tab';

/**
 * Whether My HR → Payroll applies to the signed-in member: the weldhr-payroll
 * flag is on and they are on payroll (or already have payslips). `todo` is
 * what they still have to do there: missing details plus unsigned tax forms.
 * Shared by the sidebar (item + badge) and the page itself.
 */
export function useMyPayroll(enabled = true) {
  const flag = useHrPayrollFlag();
  const on = enabled && flag.enabled;
  const details = useMyPayrollDetails({ enabled: on });
  const payslips = useMyPayslips({ enabled: on });

  return {
    flagOn: flag.enabled,
    show: on && (Boolean(details.data?.country) || (payslips.data?.length ?? 0) > 0),
    todo: details.data ? details.data.missing.length + unsignedElections(details.data).length : 0,
    isLoading: flag.isLoading || (on && (details.isLoading || payslips.isLoading)),
  };
}
