import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/credit-notes/page';

export const Route = createFileRoute('/weldbooks/credit-notes/')({
  component: PageComponent,
});
