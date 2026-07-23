import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/desktop/page';

export const Route = createFileRoute('/settings/desktop/')({
  component: PageComponent,
});
