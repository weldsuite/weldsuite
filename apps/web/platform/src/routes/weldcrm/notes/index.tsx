import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/notes/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/notes/')({
  staticData: { breadcrumb: { labelKey: 'notes' } },
  component: PageComponent,
});
