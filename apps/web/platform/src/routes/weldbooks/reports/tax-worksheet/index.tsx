import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/tax-worksheet/page';

export const Route = createFileRoute('/weldbooks/reports/tax-worksheet/')({
  component: PageComponent,
});
