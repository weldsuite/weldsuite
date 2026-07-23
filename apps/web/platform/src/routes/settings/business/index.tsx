import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/business/page';

export const Route = createFileRoute('/settings/business/')({
  component: PageComponent,
});
