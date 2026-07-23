import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/recurring/[id]/page';

export const Route = createFileRoute('/weldbooks/recurring/$id/')({
  component: PageComponent,
});
