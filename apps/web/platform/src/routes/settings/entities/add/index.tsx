import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/entities/add-page';

export const Route = createFileRoute('/settings/entities/add/')({
  component: PageComponent,
});
