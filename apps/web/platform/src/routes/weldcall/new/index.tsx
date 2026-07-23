import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcall/new/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcall/new/')({
  component: PageComponent,
});
