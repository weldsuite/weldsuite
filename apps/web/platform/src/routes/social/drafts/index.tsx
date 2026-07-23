import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/drafts/page';

export const Route = createFileRoute('/social/drafts/')({
  component: PageComponent,
});
