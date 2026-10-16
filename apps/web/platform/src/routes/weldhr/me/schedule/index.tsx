import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/schedule/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/schedule/')({
  staticData: { breadcrumb: { labelKey: 'scheduleAndHours' } },
  component: PageComponent,
});
