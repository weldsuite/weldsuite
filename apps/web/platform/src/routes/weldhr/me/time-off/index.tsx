import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/time-off/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/time-off/')({
  staticData: { breadcrumb: { label: 'Time off' } },
  component: PageComponent,
});
