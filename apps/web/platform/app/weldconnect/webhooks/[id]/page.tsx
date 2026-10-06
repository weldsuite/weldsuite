
import { useParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useWebhook, useWebhookEvents } from '@/hooks/queries/use-automation-queries';
import { WebhookDetailClient, type WebhookDetail, type WebhookEvent } from './webhook-detail-client';

export default function WebhookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();

  const { data: webhookResult, isLoading: isWebhookLoading } = useWebhook(id);
  const { data: eventsResult, isLoading: isEventsLoading } = useWebhookEvents(id);

  if (isWebhookLoading || isEventsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const webhook = webhookResult?.data;
  const events = eventsResult?.data ?? [];

  if (!webhook) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground">{t.weldconnect.webhookDetail.notFound}</p>
      </div>
    );
  }

  // Each event is a workflow run this webhook started (its id is the run's id).
  const mappedEvents: WebhookEvent[] = events.map((e) => ({
    id: e.id,
    status: e.status,
    createdAt: e.timestamp,
    executionId: e.executionId ?? e.id,
    error: e.error ?? null,
  }));

  return (
    <WebhookDetailClient
      webhook={webhook as unknown as WebhookDetail}
      initialEvents={mappedEvents}
    />
  );
}
