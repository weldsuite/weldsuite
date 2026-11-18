import { createFileRoute, redirect } from '@tanstack/react-router';
import { hrEmployeePanelHref } from '@/components/objects/hr-employee/hr-employee-tabs';

// An employee opens in the shared object panel on the employee list; the old
// detail URL (and every link to it) lands there with the panel expanded to
// fullscreen, on the tab it asked for.
export const Route = createFileRoute('/weldhr/employees/$employeeId/')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({ href: hrEmployeePanelHref(params.employeeId, search.tab), replace: true });
  },
});
