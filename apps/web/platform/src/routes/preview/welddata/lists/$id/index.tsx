import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddata/lists/[id]/page';

export const Route = createFileRoute('/preview/welddata/lists/$id/')({
  component: PageComponent,
});
