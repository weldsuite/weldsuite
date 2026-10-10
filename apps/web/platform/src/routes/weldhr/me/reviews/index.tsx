import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/reviews/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/reviews/')({
  staticData: { breadcrumb: { label: 'Reviews & goals' } },
  component: PageComponent,
});
