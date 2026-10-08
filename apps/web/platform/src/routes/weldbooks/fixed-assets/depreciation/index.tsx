import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/fixed-assets/depreciation/page';

export const Route = createFileRoute('/weldbooks/fixed-assets/depreciation/')({
  component: PageComponent,
});
