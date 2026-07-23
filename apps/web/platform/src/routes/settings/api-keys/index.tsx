import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/api-keys/page';

export const Route = createFileRoute('/settings/api-keys/')({
  component: PageComponent,
});
