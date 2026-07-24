
import { PageLoader } from '@/components/page-loader';
import { useWebhooks, useWorkflows, type Workflow } from '@/hooks/queries/use-automation-queries';
import { WebhooksClient, type WebhookView } from './webhooks-client';

export default function WebhooksPage() {
  const { data: webhooksResult, isLoading: isWebhooksLoading } = useWebhooks();
  const { data: workflowsResult, isLoading: isWorkflowsLoading } = useWorkflows();

  if (isWebhooksLoading || isWorkflowsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const webhooks = webhooksResult?.data ?? [];
  const workflows = workflowsResult?.data ?? [];

  // Create workflow name lookup
  const workflowNames = new Map(workflows.map((w: Workflow) => [w.id, w.name]));

  // Map webhooks with workflow names
  const mappedWebhooks = webhooks.map((w): WebhookView => ({
    ...(w as unknown as WebhookView),
    workflowName: w.workflowId ? workflowNames.get(w.workflowId as string) : undefined,
  }));

  return <WebhooksClient webhooks={mappedWebhooks} />;
}
