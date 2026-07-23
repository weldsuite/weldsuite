import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/ai-active/[id]/page';

export const Route = createFileRoute('/welddesk/ai-active/$id/')({
  component: PageComponent,
});
