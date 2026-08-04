
import { PageLoader } from '@/components/page-loader';
import { useTriggerTypes, useEntityEvents } from '@/hooks/queries/use-automation-queries';
import { TriggersClient } from './triggers-client';

function humanizeEventType(eventType: string): string {
  return eventType.charAt(0).toUpperCase() + eventType.slice(1).replace(/_/g, ' ');
}

export default function TriggersPage() {
  const { data: triggerTypesResult, isLoading: isTriggerTypesLoading } = useTriggerTypes();
  const { data: entityEventsResult, isLoading: isEntityEventsLoading } = useEntityEvents();

  if (isTriggerTypesLoading || isEntityEventsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const entityEvents = (entityEventsResult?.data ?? []).map((entry) => ({
    entityType: entry.entityType,
    label: entry.label,
    events: entry.events.map((event) => {
      if (typeof event === 'string') {
        return {
          id: event,
          name: humanizeEventType(event),
          description: '',
        };
      }
      return {
        id: event.id,
        name: event.name || humanizeEventType(event.id),
        description: event.description ?? '',
      };
    }),
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
