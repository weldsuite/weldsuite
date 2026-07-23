import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/phone-numbers/new-number/page';

export const Route = createFileRoute('/settings/apps/phone-numbers/new-number/')({
  component: PageComponent,
});
