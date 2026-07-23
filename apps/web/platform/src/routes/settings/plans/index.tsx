import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/plans/page';

export const Route = createFileRoute('/settings/plans/')({
  component: PageComponent,
});
