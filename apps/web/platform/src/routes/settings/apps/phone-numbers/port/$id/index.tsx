import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/phone-numbers/port/status-page';

export const Route = createFileRoute('/settings/apps/phone-numbers/port/$id/')({
  component: PageComponent,
});
