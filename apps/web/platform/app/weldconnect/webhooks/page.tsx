
import { PageLoader } from '@/components/page-loader';
import { useWebhooks, useWorkflows } from '@/hooks/queries/use-automation-queries';
import { WebhooksClient } from './webhooks-client';

export default function WebhooksPage() {
  const { data: webhooksResult, isLoading: isWebhooksLoading } = useWebhooks();
  const { data: workflowsResult, isLoading: isWorkflowsLoading } = useWorkflows();

  if (isWebhooksLoading || isWorkflowsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const webhooks = webhooksResult?.data ?? [];
  const workflows = workflowsResult?.data ?? [];

  // Create workflow name lookup
  const workflowNames = new Map(workflows.map((w: any) => [w.id, w.name]));

  // Map webhooks with workflow names
  const mappedWebhooks = webhooks.map((w: any) => ({
    ...w,
    workflowName: w.workflowId ? workflowNames.get(w.workflowId) : undefined,
  }));

  return <WebhooksClient webhooks={mappedWebhooks} />;
}
