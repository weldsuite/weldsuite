import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/accounts/page';

export const Route = createFileRoute('/social/accounts/')({
  component: PageComponent,
});
