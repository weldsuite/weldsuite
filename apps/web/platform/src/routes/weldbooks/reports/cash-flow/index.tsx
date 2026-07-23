import { createFileRoute } from '@tanstack/react-router';
import CashFlowPage from '@/app/weldbooks/reports/cash-flow/page';

export const Route = createFileRoute('/weldbooks/reports/cash-flow/')({
  component: CashFlowPage,
});
