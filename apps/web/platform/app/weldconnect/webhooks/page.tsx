
import { useWebhooks } from '@/hooks/queries/use-automation-queries';
import { WebhooksClient, type WebhookView } from './webhooks-client';

export default function WebhooksPage() {
  // The list filters and searches client-side, so load a full page up front.
  // Each row already carries its workflow's name.
  const { data: webhooksResult, isLoading } = useWebhooks({ limit: 100 });

  const webhooks = (webhooksResult?.data ?? []) as unknown as WebhookView[];

  return <WebhooksClient webhooks={webhooks} isLoading={isLoading} />;
}
