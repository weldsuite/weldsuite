import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcall/contacts/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcall/contacts/')({
  component: PageComponent,
});
