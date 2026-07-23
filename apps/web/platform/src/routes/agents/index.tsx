import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/agents/page';

export const Route = createFileRoute('/agents/')({
  component: PageComponent,
});
