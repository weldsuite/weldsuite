import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldads/accounts/page';

export const Route = createFileRoute('/weldads/accounts/')({
  staticData: { breadcrumb: { label: 'Ad accounts' } },
  component: PageComponent,
});
