import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/fixed-assets/tax-depreciation/page';

export const Route = createFileRoute('/weldbooks/fixed-assets/tax-depreciation/')({
  component: PageComponent,
});
