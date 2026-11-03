import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/email/page';

export const Route = createFileRoute('/settings/apps/welddesk/email/')({
  component: PageComponent,
});
