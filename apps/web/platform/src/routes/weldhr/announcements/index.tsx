import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/announcements/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/announcements/')({
  staticData: { breadcrumb: { labelKey: 'announcements' } },
  component: PageComponent,
});
