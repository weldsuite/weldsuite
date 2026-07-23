import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/entities/page';

export const Route = createFileRoute('/weldbooks/entities/')({
  component: PageComponent,
});
