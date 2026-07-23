import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/suppliers/page';

export const Route = createFileRoute('/weldbooks/suppliers/')({
  component: PageComponent,
});
