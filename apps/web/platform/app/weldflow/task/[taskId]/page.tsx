import { useEffect } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { useTaskById } from '@/components/objects/task/use-task-data';

/**
 * Stable, project-independent task link: `/weldflow/task/{taskId}`.
 *
 * Notifications, mail, chat and the API can point at a task without knowing
 * its project. This page looks the task up and forwards to the page that owns
 * it with the task panel open (`?stack=task:{id}:panel`): the project's task
 * list, or My Tasks for a task outside any project.
 */
export default function TaskLinkPage() {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const taskId = params.taskId as string;
  const taskQuery = useTaskById(taskId);
  const task = taskQuery.data;

  useEffect(() => {
    if (!task) return;
    const stack = `stack=task:${task.id}:panel`;
    const base = task.projectId ? `/weldflow/project/${task.projectId}/tasks` : '/weldflow';
    router.replace(`${base}?${stack}`);
  }, [task, router]);

  if (taskQuery.isError || (!taskQuery.isLoading && !task)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {t('sweep.entities.taskNotFound')}
      </div>
    );
  }

  return <PageLoader />;
}
