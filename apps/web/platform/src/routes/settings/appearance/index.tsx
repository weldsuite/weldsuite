import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/appearance/page';

export const Route = createFileRoute('/settings/appearance/')({
  component: PageComponent,
});
