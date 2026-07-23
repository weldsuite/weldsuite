
import { PageLoader } from '@/components/page-loader';
import { useTriggerTypes, useEntityEvents } from '@/hooks/queries/use-automation-queries';
import { TriggersClient } from './triggers-client';

export default function TriggersPage() {
  const { data: triggerTypesResult, isLoading: isTriggerTypesLoading } = useTriggerTypes();
  const { data: entityEventsResult, isLoading: isEntityEventsLoading } = useEntityEvents();

  if (isTriggerTypesLoading || isEntityEventsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        <TriggersClient
          triggerTypes={triggerTypesResult?.data ?? []}
          entityEvents={entityEventsResult?.data ?? []}
        />
      </div>
    </div>
  );
}
