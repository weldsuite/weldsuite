import { useCallback, useMemo } from 'react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useParams, usePathname, useRouter, useSearchParams } from '@/lib/router';
import { useProjectDelivery, useProjectSprints } from '@/hooks/queries/use-flow-agile-queries';
import { defaultSprintId } from '@/app/weldflow/lib/sprint-metrics';
import { PipelineView } from './_components/pipeline-view';

/** `?sprint=` value for "All open work"; no value means the project's default sprint. */
const ALL_OPEN = 'all';

/**
 * The Pipeline tab. A project that plans in sprints shows one sprint at a time:
 * the one in `?sprint=` (`all` for all open work), else the active sprint, else
 * the next planned one.
 */
export default function Page() {
  const params = useParams();
  const projectId = params.projectId as string;
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const delivery = useProjectDelivery(projectId);
  const sprints = useProjectSprints(projectId, delivery.usesSprints);
  const chosen = search.get('sprint');

  const sprintId = useMemo<string | null>(() => {
    if (!delivery.usesSprints) return null;
    if (chosen === ALL_OPEN) return null;
    if (chosen) return chosen;
    return defaultSprintId(sprints.data ?? []);
  }, [delivery.usesSprints, chosen, sprints.data]);

  const onSprintChange = useCallback(
    (next: string | null) => router.replace(`${pathname}?sprint=${encodeURIComponent(next ?? ALL_OPEN)}`),
    [router, pathname],
  );

  // Wait for the delivery setting and the sprint list, so the board loads once, for the right sprint.
  const waiting = delivery.isLoading || (delivery.usesSprints && sprints.isLoading);
  if (waiting) return <PageLoader fullScreen={false} />;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <PipelineView projectId={projectId} sprintId={sprintId} onSprintChange={delivery.usesSprints ? onSprintChange : undefined} />
    </div>
  );
}
