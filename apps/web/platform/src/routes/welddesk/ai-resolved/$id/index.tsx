import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/ai-resolved/[id]/page';

export const Route = createFileRoute('/welddesk/ai-resolved/$id/')({
  component: PageComponent,
});
