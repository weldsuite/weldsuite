
import { useParams } from '@/lib/router';
import { GoalsCanvasView } from '@/components/weldflow/goals/goals-canvas-view';
import { useProject, useProjectGoals, useProjectTasks } from '@/hooks/queries/use-projects-queries';
import type { ProjectGoals } from '@/lib/api/domains/weldflow';
import { useI18n } from '@/lib/i18n/provider';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';

// `useProjectTasks` returns an untyped `data: any[]` (see the matching note in
// `hooks/queries/use-projects-queries.ts`) — narrow to just the fields read here.
interface GoalsPageTask {
  id: string;
  title: string;
  priority: string;
}

export default function GoalsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { t } = useI18n();

  const { data: projectData, isLoading: projectLoading } = useProject(projectId);
  const {
    data: goalsData,
    isLoading: goalsLoading,
    isError: goalsError,
    isFetching: goalsFetching,
    isFetchedAfterMount: goalsFetchedAfterMount,
    refetch: refetchGoals,
  } = useProjectGoals(projectId);
  const { data: tasksData, isLoading: tasksLoading } = useProjectTasks(projectId, { pageSize: 100 });

  // Wait for a fresh server response (not just a cached one) before mounting the
  // canvas: the canvas seeds its state from these props, so seeding it with a
  // stale cache entry or the empty default would let the next save overwrite
  // real goals.
  const goalsSettled = goalsFetchedAfterMount || goalsError || !goalsFetching;
  const isLoading = projectLoading || goalsLoading || tasksLoading || !goalsSettled;

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Never fall back to the empty default when the load failed or returned no
  // data; that default would be autosaved over the stored goals.
  if (goalsError || !goalsData?.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">{t.projects.goals.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => refetchGoals()}>
          {t.projects.goals.retry}
        </Button>
      </div>
    );
  }

  const projectName = projectData?.data?.name || 'Project';

  const goals: ProjectGoals = {
    ...goalsData.data,
    mission: goalsData.data.mission ?? {
      id: 'mission-1',
      title: projectName,
      description: t.projects.goals.ourMission,
      x: 600,
      y: 50,
      width: 320,
      height: 160,
      subGoals: []
    },
    goals: goalsData.data.goals ?? [],
  };

  // Transform tasks for the goals component
  const existingTasks = (tasksData?.data || []).map((task: GoalsPageTask) => ({
    id: task.id,
    title: task.title,
    projectName: projectData?.data?.name,
    priority: task.priority,
  }));

  return (
    <GoalsCanvasView
      key={projectId}
      projectId={projectId}
      initialGoalsData={goals}
      initialTasks={existingTasks}
    />
  );
}
