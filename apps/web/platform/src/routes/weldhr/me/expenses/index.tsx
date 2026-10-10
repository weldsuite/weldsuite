import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/expenses/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/expenses/')({
  staticData: { breadcrumb: { label: 'Expenses' } },
  component: PageComponent,
});
