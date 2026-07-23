import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/settings/accounts/page';

export const Route = createFileRoute('/weldmail/settings/accounts/')({
  component: PageComponent,
});
