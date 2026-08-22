import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldads/campaigns/page';

export const Route = createFileRoute('/weldads/campaigns/')({
  staticData: { breadcrumb: { label: 'Campaigns' } },
  component: PageComponent,
});
