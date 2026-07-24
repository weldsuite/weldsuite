
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

  // The webhook-events endpoint only reports `timestamp`, not the richer
  // execution/payload fields the detail view optionally renders.
  const mappedEvents: WebhookEvent[] = events.map((e) => ({
    id: e.id,
    status: e.status,
    createdAt: e.timestamp,
  }));

  return (
    <WebhookDetailClient
      webhook={webhook as unknown as WebhookDetail}
      initialEvents={mappedEvents}
    />
  );
}
