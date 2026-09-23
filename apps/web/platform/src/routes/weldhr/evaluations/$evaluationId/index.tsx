import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/evaluations/[evaluationId]/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/evaluations/$evaluationId/')({
  component: PageComponent,
});
