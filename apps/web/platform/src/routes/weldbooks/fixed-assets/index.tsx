import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/fixed-assets/page';

export const Route = createFileRoute('/weldbooks/fixed-assets/')({
  component: PageComponent,
});
