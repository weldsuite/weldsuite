import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/pipeline/[id]/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/preview/weldcrm/pipeline/$id/')({
  component: PageComponent,
});
