
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useTriggerTypes, useEntityEvents, type TriggerType } from '@/hooks/queries/use-automation-queries';
import { TriggersClient } from './triggers-client';

function humanizeEventType(eventType: string): string {
  return eventType.charAt(0).toUpperCase() + eventType.slice(1).replace(/_/g, ' ');
}

const KNOWN_TRIGGER_IDS = new Set([
  'manual',
  'schedule',
  'webhook',
  'entity_event',
  'integration_event',
  'workflow_complete',
  'api',
]);

function localizeTriggerTypes(
  triggers: TriggerType[],
  types: Record<string, { name?: string; description?: string }>,
): TriggerType[] {
  return triggers.map((trigger) => {
    const key = KNOWN_TRIGGER_IDS.has(trigger.id) ? trigger.id : trigger.category;
    const localized = types[key];
    if (!localized) return trigger;
    return {
      ...trigger,
      name: localized.name ?? trigger.name,
      description: localized.description ?? trigger.description,
    };
  });
}

export default function TriggersPage() {
  const { t } = useI18n();
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

  const triggerTypes = localizeTriggerTypes(
    triggerTypesResult?.data ?? [],
    t.weldconnect.triggers.types,
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        <TriggersClient
          triggerTypes={triggerTypes}
          entityEvents={entityEvents}
        />
      </div>
    </div>
  );
}
