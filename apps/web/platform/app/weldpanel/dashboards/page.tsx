import { useState } from 'react';
import { LayoutDashboard, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useCreateWeldPanelDashboard, useWeldPanelDashboards } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { AnalyticsPage } from '../components/analytics-page';
import { NameDialog } from '../components/name-dialog';
import { formatDate } from '../lib/format';

function DashboardsList({ projectId, creating, onCreatingChange }: Readonly<{ projectId: string; creating: boolean; onCreatingChange: (open: boolean) => void }>) {
  const { t, language } = useI18n();
  const td = t.weldpanel.analytics.dashboards;
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  const canCreate = useCan('panel_reports:create');
  const { data: dashboards, isLoading, isError, refetch } = useWeldPanelDashboards({ projectId });
  const create = useCreateWeldPanelDashboard();

  if (isError) return <ErrorState message={td.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;

  return (
    <>
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      )}
      {!isLoading && (!dashboards || dashboards.length === 0) && (
        <EmptyState
          icon={LayoutDashboard}
          title={td.emptyTitle}
          description={td.emptyDescription}
          action={
            canCreate ? (
              <Button size="sm" onClick={() => onCreatingChange(true)}>
                <Plus />
                {td.newDashboard}
              </Button>
            ) : undefined
          }
        />
      )}
      {!isLoading && dashboards && dashboards.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((dashboard) => (
            <li key={dashboard.id}>
              <Link href={`/weldpanel/dashboards/${dashboard.id}`} className="block h-full rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
                <Card className="h-full gap-2 py-4 transition-colors hover:bg-accent/40">
                  <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 px-4 pb-0">
                    <CardTitle className="truncate text-base">{dashboard.name}</CardTitle>
                    <SoftBadge tone={dashboard.visibility === 'workspace' ? 'success' : 'neutral'}>{dashboard.visibility === 'workspace' ? tc.workspace : tc.private}</SoftBadge>
                  </CardHeader>
                  <CardContent className="px-4">
                    {dashboard.description && <p className="line-clamp-2 text-sm text-muted-foreground">{dashboard.description}</p>}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {tc.updated} {formatDate(dashboard.updatedAt, language)}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <NameDialog
        open={creating}
        onOpenChange={onCreatingChange}
        title={td.createTitle}
        description={td.createDescription}
        submitLabel={tc.create}
        namePlaceholder={td.namePlaceholder}
        showDescription
        showVisibility
        onSubmit={async (values) => {
          try {
            const dashboard = await create.mutateAsync({
              projectId,
              name: values.name,
              description: values.description.trim() === '' ? null : values.description.trim(),
              visibility: values.visibility,
            });
            toast.success(td.created);
            onCreatingChange(false);
            router.push(`/weldpanel/dashboards/${dashboard.id}`);
          } catch {
            toast.error(td.createFailed);
          }
        }}
      />
    </>
  );
}

export default function DashboardsPage() {
  const { t } = useI18n();
  const td = t.weldpanel.analytics.dashboards;
  const canCreate = useCan('panel_reports:create');
  const [creating, setCreating] = useState(false);
  return (
    <AnalyticsPage
      title={td.title}
      description={td.description}
      actions={
        canCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {td.newDashboard}
          </Button>
        ) : undefined
      }
    >
      {(project) => <DashboardsList key={project.id} projectId={project.id} creating={creating} onCreatingChange={setCreating} />}
    </AnalyticsPage>
  );
}
