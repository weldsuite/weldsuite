import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/phone/page';

export const Route = createFileRoute('/settings/apps/welddesk/phone/')({
  component: PageComponent,
});
