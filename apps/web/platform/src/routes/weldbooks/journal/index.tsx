import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/journal/page';

export const Route = createFileRoute('/weldbooks/journal/')({
  component: PageComponent,
});
