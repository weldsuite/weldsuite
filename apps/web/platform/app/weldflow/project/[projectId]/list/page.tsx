import { useParams } from '@/lib/router';
import { TasksView } from '@/components/weldflow/tasks/tasks-view';
import { useProjectTasks } from '@/hooks/queries/use-projects-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { ListLoadError } from '@/app/weldflow/components/list-load-error';

export default function ProjectListPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { t } = useI18n();

  const { data, isLoading, isError, refetch } = useProjectTasks(projectId, { pageSize: 100 });

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (isError && !data) {
    return (
      <ListLoadError
        message={t.projects.tasks.failedToLoad}
        retryLabel={t.projects.tasks.retry}
        onRetry={() => { void refetch(); }}
      />
    );
  }

  return <TasksView projectId={projectId} initialTasks={data?.data || []} />;
}
