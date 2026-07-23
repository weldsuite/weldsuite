import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/privacy/page';

export const Route = createFileRoute('/settings/privacy/')({
  component: PageComponent,
});
