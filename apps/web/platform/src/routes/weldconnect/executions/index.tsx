import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldconnect/executions/page';

export const Route = createFileRoute('/weldconnect/executions/')({
  // Deep links from the dashboard tiles and the editor: ?status=failed, ?workflowId=<id>.
  validateSearch: (search: Record<string, unknown>) => ({
    status: typeof search.status === 'string' ? search.status : undefined,
    workflowId: typeof search.workflowId === 'string' ? search.workflowId : undefined,
    triggerType: typeof search.triggerType === 'string' ? search.triggerType : undefined,
  }),
  component: PageComponent,
});
