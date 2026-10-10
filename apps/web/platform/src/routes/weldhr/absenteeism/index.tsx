import { createFileRoute, redirect } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/absenteeism/page';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/absenteeism/')({
  staticData: { breadcrumb: { label: 'Absenteeism' } },
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  // Reporting yourself sick moved from the "My absence" tab to My HR → Time off.
  beforeLoad: ({ search }) => {
    if (search.tab === 'mine') throw redirect({ to: MY_HR_PATHS.timeOff, replace: true });
  },
  component: PageComponent,
});
