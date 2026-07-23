import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/profit-loss/page';

export const Route = createFileRoute('/weldbooks/reports/profit-loss/')({
  component: PageComponent,
});
