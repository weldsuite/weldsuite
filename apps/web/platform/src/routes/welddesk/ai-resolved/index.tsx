import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/ai-resolved/page';

export const Route = createFileRoute('/welddesk/ai-resolved/')({
  component: PageComponent,
});
