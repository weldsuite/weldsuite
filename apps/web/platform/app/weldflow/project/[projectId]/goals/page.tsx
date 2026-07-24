
import { useParams } from '@/lib/router';
import { GoalsCanvasView } from '@/components/weldflow/goals/goals-canvas-view';
import { useProject, useProjectGoals, useProjectTasks } from '@/hooks/queries/use-projects-queries';
import type { ProjectGoals } from '@/lib/api/domains/weldflow';
import { useI18n } from '@/lib/i18n/provider';
import { PageLoader } from '@/components/page-loader';

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
  const { data: goalsData, isLoading: goalsLoading } = useProjectGoals(projectId);
  const { data: tasksData, isLoading: tasksLoading } = useProjectTasks(projectId, { pageSize: 100 });

  const isLoading = projectLoading || goalsLoading || tasksLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const projectName = projectData?.data?.name || 'Project';

  // Default goals data
  let goals: ProjectGoals = {
    mission: {
      id: 'mission-1',
      title: projectName,
      description: t.projects.goals.ourMission,
      x: 600,
      y: 50,
      width: 320,
      height: 160,
      subGoals: []
    },
    goals: []
  };

  if (goalsData?.data) {
    goals = goalsData.data;
  }

  // Transform tasks for the goals component
  const existingTasks = (tasksData?.data || []).map((task: GoalsPageTask) => ({
    id: task.id,
    title: task.title,
    projectName: projectData?.data?.name,
    priority: task.priority,
  }));

  return (
    <GoalsCanvasView
      projectId={projectId}
      initialGoalsData={goals}
      initialTasks={existingTasks}
    />
  );
}
