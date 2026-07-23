import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/balance-sheet/page';

export const Route = createFileRoute('/weldbooks/reports/balance-sheet/')({
  component: PageComponent,
});
