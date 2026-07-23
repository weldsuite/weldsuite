import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/ai-active/page';

export const Route = createFileRoute('/welddesk/ai-active/')({
  component: PageComponent,
});
