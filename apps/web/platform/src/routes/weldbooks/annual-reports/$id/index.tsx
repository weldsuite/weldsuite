import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/annual-reports/[id]/page';

export const Route = createFileRoute('/weldbooks/annual-reports/$id/')({
  component: PageComponent,
});
