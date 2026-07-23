import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/object-templates/page';

export const Route = createFileRoute('/settings/object-templates/')({
  component: PageComponent,
});
