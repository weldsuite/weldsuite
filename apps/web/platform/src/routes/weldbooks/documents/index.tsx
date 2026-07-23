import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/documents/page';

export const Route = createFileRoute('/weldbooks/documents/')({
  component: PageComponent,
});
