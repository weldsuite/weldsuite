import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/fixed-assets/[id]/page';

export const Route = createFileRoute('/weldbooks/fixed-assets/$id/')({
  component: PageComponent,
});
