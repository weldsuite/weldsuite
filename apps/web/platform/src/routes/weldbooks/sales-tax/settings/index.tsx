import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/settings/page';

export const Route = createFileRoute('/weldbooks/sales-tax/settings/')({
  component: PageComponent,
});
