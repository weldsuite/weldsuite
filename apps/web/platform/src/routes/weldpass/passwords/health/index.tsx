import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/passwords/health/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpass/passwords/health/')({
  staticData: { breadcrumb: { label: 'Password health' } },
  component: PageComponent,
});
