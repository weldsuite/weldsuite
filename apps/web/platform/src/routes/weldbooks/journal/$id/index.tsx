import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/journal/[id]/page';

export const Route = createFileRoute('/weldbooks/journal/$id/')({
  component: PageComponent,
});
