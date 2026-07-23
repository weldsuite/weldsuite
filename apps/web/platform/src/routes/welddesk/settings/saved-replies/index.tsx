import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/saved-replies/page';

export const Route = createFileRoute('/welddesk/settings/saved-replies/')({
  component: PageComponent,
});
