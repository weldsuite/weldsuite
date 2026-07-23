import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/entities/add-page';

export const Route = createFileRoute('/weldbooks/entities/add/')({
  component: PageComponent,
});
