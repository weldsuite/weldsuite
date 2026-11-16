import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/flows/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/flows/')({
  staticData: { breadcrumb: { labelKey: 'flows' } },
  component: PageComponent,
});
