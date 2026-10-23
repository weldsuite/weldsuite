import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/sso/page';

export const Route = createFileRoute('/settings/sso/')({
  component: PageComponent,
});
