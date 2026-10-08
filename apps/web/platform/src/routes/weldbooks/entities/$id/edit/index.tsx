import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/entities/edit-page';

export const Route = createFileRoute('/weldbooks/entities/$id/edit/')({
  component: PageComponent,
});
