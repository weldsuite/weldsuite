
import { PageLoader } from '@/components/page-loader';
import { useTriggerTypes, useEntityEvents } from '@/hooks/queries/use-automation-queries';
import { TriggersClient } from './triggers-client';

// The entity-events endpoint reports each object's events as bare type
// strings (e.g. "created"); the client renders event cards, so give each one
// a display name until the API carries richer metadata.
function humanizeEventType(eventType: string): string {
  return eventType.charAt(0).toUpperCase() + eventType.slice(1).replace(/_/g, ' ');
}

export default function TriggersPage() {
  const { data: triggerTypesResult, isLoading: isTriggerTypesLoading } = useTriggerTypes();
  const { data: entityEventsResult, isLoading: isEntityEventsLoading } = useEntityEvents();

  if (isTriggerTypesLoading || isEntityEventsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const entityEvents = (entityEventsResult?.data ?? []).map(({ entityType, events }) => ({
    entityType,
    events: events.map((eventType) => ({
      id: `${entityType}.${eventType}`,
      name: humanizeEventType(eventType),
      description: '',
    })),
  }));

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        <TriggersClient
          triggerTypes={triggerTypesResult?.data ?? []}
          entityEvents={entityEvents}
        />
      </div>
    </div>
  );
}
