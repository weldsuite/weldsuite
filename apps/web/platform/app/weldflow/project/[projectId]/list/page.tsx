
import { useParams } from '@/lib/router';
import { TasksView } from '@/components/weldflow/tasks/tasks-view';
import { useProjectTasks } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';

export default function ProjectListPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const { data, isLoading } = useProjectTasks(projectId, { pageSize: 100 });

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <TasksView projectId={projectId} initialTasks={data?.data || []} />;
}
