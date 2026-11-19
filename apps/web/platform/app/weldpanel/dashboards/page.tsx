import { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelDashboardDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { useCan } from '@weldsuite/permissions/react';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useCreateWeldPanelDashboard, useWeldPanelDashboards } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { AnalyticsListPage } from '../components/analytics-page';
import { NameDialog } from '../components/name-dialog';
import { formatDate } from '../lib/format';
import { NewDashboardDialog } from './new-dashboard-dialog';

function DashboardsList({ projectId, creating, onCreatingChange }: Readonly<{ projectId: string; creating: boolean; onCreatingChange: (open: boolean) => void }>) {
  const { t, language } = useI18n();
  const td = t.weldpanel.analytics.dashboards;
  const tc = t.weldpanel.analytics.common;
  const router = useRouter();
  const canCreate = useCan('panel_reports:create');
  const { data: dashboards, isLoading, isError, refetch } = useWeldPanelDashboards({ projectId });
  const create = useCreateWeldPanelDashboard();
  // "New dashboard" offers the templates first; "Empty dashboard" there opens the name form.
  const [blank, setBlank] = useState(false);

  if (isError) return <ErrorState message={td.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  if (isLoading && !dashboards) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  const columns: ColumnDef<PanelDashboardDto>[] = [
    {
      id: 'name',
      header: tc.name,
      width: 'flex-1 min-w-[180px]',
      render: (dashboard) => <span className="block truncate font-medium">{dashboard.name}</span>,
    },
    {
      id: 'visibility',
      header: tc.visibility,
      width: 'w-[120px]',
      render: (dashboard) => <SoftBadge tone={dashboard.visibility === 'workspace' ? 'success' : 'neutral'}>{dashboard.visibility === 'workspace' ? tc.workspace : tc.private}</SoftBadge>,
    },
    {
      id: 'description',
      header: tc.description,
      width: 'hidden md:block md:w-[320px]',
      render: (dashboard) => <span className="block truncate text-muted-foreground">{dashboard.description ?? '–'}</span>,
    },
    {
      id: 'updated',
      header: tc.updated,
      width: 'hidden sm:block sm:w-[120px]',
      render: (dashboard) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDate(dashboard.updatedAt, language)}</span>,
    },
  ];

  return (
    <>
      <PanelEntityList<PanelDashboardDto>
        items={dashboards ?? []}
        isLoading={false}
        columns={columns}
        hideFilter
        createButton={canCreate ? { label: td.newDashboard, onClick: () => onCreatingChange(true) } : undefined}
        onRowClick={(dashboard) => router.push(`/weldpanel/dashboards/${dashboard.id}`)}
        emptyState={{
          icon: <LayoutDashboard className="size-8 text-muted-foreground" />,
          title: td.emptyTitle,
          description: td.emptyDescription,
          action: canCreate ? { label: td.newDashboard, onClick: () => onCreatingChange(true) } : undefined,
        }}
      />

      <NewDashboardDialog open={creating} onOpenChange={onCreatingChange} projectId={projectId} onBlank={() => setBlank(true)} />
      <NameDialog
        open={blank}
        onOpenChange={setBlank}
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
            setBlank(false);
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
  const [creating, setCreating] = useState(false);
  return (
    <AnalyticsListPage title={td.title}>
      {(project) => <DashboardsList key={project.id} projectId={project.id} creating={creating} onCreatingChange={setCreating} />}
    </AnalyticsListPage>
  );
}
