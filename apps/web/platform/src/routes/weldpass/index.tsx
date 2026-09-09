import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpass/')({
  staticData: { breadcrumb: { label: 'Projects' } },
  component: PageComponent,
});
