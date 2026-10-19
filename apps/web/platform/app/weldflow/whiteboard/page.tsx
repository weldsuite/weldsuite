import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Presentation } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { useRouter } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { PageLoader } from '@/components/page-loader';
import { formatMediumDateNow } from '@/lib/i18n/date-locale';
import { whiteboardApi } from '@/app/weldflow/lib/api-client';
import { projectKeys, useProjects } from '@/hooks/queries/use-projects-queries';

/**
 * Whiteboards across every project the user can access.
 *
 * A whiteboard always belongs to a project (`project_whiteboards.project_id`), so this
 * page used to render an editor on a made-up "global-whiteboard" project that failed to
 * save on every edit. It is now a read-only index that opens each board in its project.
 */
export default function WhiteboardPage() {
  const st = useTranslations();
  const router = useRouter();

  useBreadcrumbs([
    { label: st('sweep.weldflow.whiteboardListPage.projects'), href: '/weldflow' },
    { label: st('sweep.weldflow.whiteboardListPage.whiteboards') },
  ]);

  const boards = useQuery({
    queryKey: [...projectKeys.all, 'whiteboards', 'all'],
    queryFn: async () => {
      const result = await whiteboardApi.listAll();
      if (!result.success || !result.data) throw new Error('Failed to load whiteboards');
      return result.data;
    },
  });
  const projects = useProjects({ pageSize: 100 });

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data?.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);

  if (boards.isLoading) return <PageLoader fullScreen={false} />;

  if (boards.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center" role="alert">
        <p className="text-sm text-muted-foreground">{st('sweep.weldflow.whiteboardListPage.loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => void boards.refetch()}>
          {st('sweep.weldflow.whiteboardListPage.retry')}
        </Button>
      </div>
    );
  }

  const items = boards.data ?? [];

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
        <Presentation className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <p className="text-lg font-medium">{st('sweep.weldflow.whiteboardListPage.emptyTitle')}</p>
        <p className="text-sm text-muted-foreground">{st('sweep.weldflow.whiteboardListPage.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl p-4">
      <h1 className="mb-3 text-lg font-semibold">{st('sweep.weldflow.whiteboardListPage.allProjects')}</h1>
      <ul className="divide-y rounded-md border">
        {items.map((board) => {
          const projectName = board.projectId ? projectNames.get(board.projectId) : undefined;
          return (
            <li key={board.id}>
              <button
                type="button"
                disabled={!board.projectId}
                onClick={() => router.push(`/weldflow/project/${board.projectId}/whiteboard/${board.id}`)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {board.name || st('sweep.weldflow.whiteboardListPage.untitled')}
                </span>
                {projectName && (
                  <span className="hidden max-w-[220px] truncate text-sm text-muted-foreground sm:block">
                    {projectName}
                  </span>
                )}
                <span className="shrink-0 text-sm tabular-nums">{formatMediumDateNow(board.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
