import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/approvals/page';

export const Route = createFileRoute('/social/approvals/')({
  component: PageComponent,
});
