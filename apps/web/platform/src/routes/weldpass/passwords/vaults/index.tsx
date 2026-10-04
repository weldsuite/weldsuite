import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpass/passwords/vaults/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpass/passwords/vaults/')({
  staticData: { breadcrumb: { label: 'Vaults' } },
  component: PageComponent,
});
