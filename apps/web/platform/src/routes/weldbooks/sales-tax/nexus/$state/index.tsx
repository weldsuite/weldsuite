import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/nexus/[state]/page';

export const Route = createFileRoute('/weldbooks/sales-tax/nexus/$state/')({
  component: PageComponent,
});
