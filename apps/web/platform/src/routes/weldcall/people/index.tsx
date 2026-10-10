import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcall/people/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcall/people/')({
  component: PageComponent,
});
