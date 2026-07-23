import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/ai-agents/page';

export const Route = createFileRoute('/welddesk/weldagent/')({
  component: PageComponent,
});
