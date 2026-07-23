import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcall/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcall/')({
  component: PageComponent,
});
