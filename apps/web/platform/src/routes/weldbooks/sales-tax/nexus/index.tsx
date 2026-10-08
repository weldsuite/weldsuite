import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/nexus/page';

export const Route = createFileRoute('/weldbooks/sales-tax/nexus/')({
  component: PageComponent,
});
