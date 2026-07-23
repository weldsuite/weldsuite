import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/agents/[id]/page';

export const Route = createFileRoute('/agents/$id/')({
  component: PageComponent,
});
