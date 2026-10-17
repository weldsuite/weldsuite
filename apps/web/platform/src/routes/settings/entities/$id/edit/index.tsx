import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/entities/edit-page';

export const Route = createFileRoute('/settings/entities/$id/edit/')({
  component: PageComponent,
});
