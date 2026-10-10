import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/team-page';

export const Route = createFileRoute('/partner/team/')({
  component: PageComponent,
});
