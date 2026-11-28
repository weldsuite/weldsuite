import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/documents/review/page';

export const Route = createFileRoute('/weldbooks/documents/$id/review/')({
  component: PageComponent,
});
