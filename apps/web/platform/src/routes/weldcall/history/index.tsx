import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcall/history/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcall/history/')({
  component: PageComponent,
});
