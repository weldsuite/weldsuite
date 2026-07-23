import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/billing/page';

export const Route = createFileRoute('/settings/billing/')({
  component: PageComponent,
});
