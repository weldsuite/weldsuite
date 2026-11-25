/**
 * An epic's page (or a feature's): its progress from the items' points, the
 * burnup, the items by sprint, what is linked to it and its description.
 * Reached from the Backlog's epics panel, an epic chip or the task panel.
 */

import { useEffect, useMemo } from 'react';
import { isApiError } from '@weldsuite/api-client';
import { toast } from 'sonner';
import { DetailHeader } from '@weldsuite/ui/components/page-layout';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useObjectPanel } from '@/components/object-panel';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { DescriptionField } from '@/components/task-detail/task-detail-content';
import { descriptionToHtml } from '@/components/task-detail/description-html';
import { buildTaskUpdatePayload } from '@/components/objects/task/task-update-payload';
import { useTaskById, useUpdateTask } from '@/components/objects/task/use-task-data';
import { QuickCreateItem } from '@/components/weldflow/agile/quick-create-item';
import { TaskTypeBadge } from '@/components/weldflow/agile/task-type-badge';
import { groupEpicItems, pickableTypes, sumPoints } from '@/app/weldflow/lib/backlog';
import { itemTypeOf, isContainerType } from '@/app/weldflow/lib/item-types';
import { useEpicItems, useEpicLinks, useCreateItem } from '@/hooks/queries/use-flow-agile-backlog-queries';
import { useProjectDelivery, useProjectEpics, useProjectSprints } from '@/hooks/queries/use-flow-agile-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useDateLocale } from '@/lib/i18n/date-locale';
import { useParams, useRouter } from '@/lib/router';
import { apiMessage } from '../../close/_lib/api-error';
import { BurnupChart } from './_components/burnup-chart';
import { EpicItems } from './_components/epic-items';
import { EpicLinks } from './_components/epic-links';

export default function EpicPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const epicId = params.epicId as string;
  const router = useRouter();
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const { formatShort } = useDateLocale();
  const { canWrite } = useProjectPermissions();
  const { open: openPanel } = useObjectPanel();

  const delivery = useProjectDelivery(projectId);
  const available = delivery.available && delivery.usesItemTypes;
  useEffect(() => {
    if (!delivery.isLoading && !available) router.replace(`/weldflow/project/${projectId}/tasks`);
  }, [delivery.isLoading, available, projectId, router]);

  const epicQuery = useTaskById(available ? epicId : null);
  const epicsQuery = useProjectEpics(projectId, available);
  const itemsQuery = useEpicItems(projectId, epicId);
  const sprintsQuery = useProjectSprints(projectId, available && delivery.usesSprints);
  const linksQuery = useEpicLinks(projectId, epicId);
  const createItem = useCreateItem(projectId);
  const updateEpic = useUpdateTask(epicId);

  const epic = epicQuery.data;
  const rollup = (epicsQuery.data ?? []).find((entry) => entry.id === epicId);
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const groups = useMemo(() => groupEpicItems(items, sprintsQuery.data ?? []), [items, sprintsQuery.data]);
  const settings = delivery.settings;
  const types = pickableTypes(delivery.enabledTypes).filter((type) => !isContainerType(type) || type === 'feature');

  const statusLabels: Record<string, string> = {
    backlog: t.projects.tasks.statusBacklog,
    todo: t.projects.tasks.statusTodo,
    in_progress: t.projects.tasks.statusInProgress,
    review: t.projects.tasks.statusInReview,
    testing: t.projects.tasks.statusTesting,
    done: t.projects.tasks.statusDone,
    cancelled: t.projects.tasks.statusCancelled,
  };

  const backToBacklog = () => router.push(`/weldflow/project/${projectId}/tasks/backlog`);

  if (delivery.isLoading || !available || epicQuery.isLoading) return <PageLoader fullScreen={false} />;

  const notFound =
    (epicQuery.isError && isApiError(epicQuery.error) && epicQuery.error.status === 404) ||
    (!!epic && (epic.projectId !== projectId || !isContainerType(itemTypeOf(epic.type, { featureLevel: true }))));
  if (notFound) {
    return (
      <div className="p-6">
        <EmptyState
          title={copy.epicPage.notFound}
          action={
            <Button type="button" variant="outline" onClick={backToBacklog}>
              {copy.epicPage.backToBacklog}
            </Button>
          }
        />
      </div>
    );
  }
  if (epicQuery.isError || !epic) {
    return (
      <div className="p-6">
        <ErrorState message={copy.epicPage.loadFailed} onRetry={() => void epicQuery.refetch()} retryLabel={t.flowAgile.shared.retry} />
      </div>
    );
  }

  const itemTotal = rollup?.items ?? items.length;
  const itemsDone = rollup?.done ?? items.filter((item) => item.status === 'done').length;
  const pointsTotal = rollup?.points ?? sumPoints(items);
  const pointsDone = rollup?.donePoints ?? sumPoints(items.filter((item) => item.status === 'done'));
  const percent = pointsTotal > 0 ? Math.round((pointsDone / pointsTotal) * 100) : itemTotal > 0 ? Math.round((itemsDone / itemTotal) * 100) : 0;
  const status = epic.status;

  return (
    <div className="space-y-6 p-3 md:p-4">
      <DetailHeader
        onBack={backToBacklog}
        backLabel={copy.epicPage.backToBacklog}
        leading={
          <TaskTypeBadge type={epic.type} naming={settings.itemTypes.naming} featureLevel={settings.itemTypes.featureLevel} className="mt-2 flex-none" />
        }
        title={epic.title}
        badges={
          <SoftBadge tone={status === 'done' ? 'success' : 'neutral'}>{statusLabels[status] ?? status}</SoftBadge>
        }
        subtitle={epic.number != null ? `#${epic.number}` : undefined}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => openPanel({ type: 'task', id: epic.id })}>
            {t.flowAgile.shared.open}
          </Button>
        }
      />

      <KpiGrid>
        <KpiCard
          label={copy.epicPage.progress}
          value={format(copy.epicPage.percentDone, { percent })}
          hint={pointsTotal > 0 ? format(copy.epicPage.pointsDone, { done: pointsDone, total: pointsTotal }) : undefined}
          tone={percent === 100 ? 'success' : 'default'}
        />
        <KpiCard
          label={copy.epicPage.items}
          value={format(copy.epicPage.itemsDone, { done: itemsDone, total: itemTotal })}
          hint={plural(Math.max(itemTotal - itemsDone, 0), copy.epicPage.openItems)}
        />
        <KpiCard label={copy.epicPage.status} value={statusLabels[status] ?? status} />
        <KpiCard label={copy.epicPage.dueDate} value={epic.dueDate ? formatShort(epic.dueDate) : copy.epicPage.noDate} />
      </KpiGrid>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-labelledby="epic-items-heading" className="min-w-0 space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="epic-items-heading" className="text-sm font-semibold">
              {copy.epicPage.itemsTitle}
            </h2>
            {delivery.usesSprints ? <span className="text-xs text-muted-foreground">{copy.epicPage.groupedBySprint}</span> : null}
          </div>
          {itemsQuery.isLoading ? <Skeleton className="h-32 w-full" /> : null}
          {itemsQuery.isError ? (
            <ErrorState message={copy.epicPage.loadFailed} onRetry={() => void itemsQuery.refetch()} retryLabel={t.flowAgile.shared.retry} />
          ) : null}
          {!itemsQuery.isLoading && !itemsQuery.isError && groups.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{copy.epicPage.emptyItems}</p>
          ) : null}
          <EpicItems
            groups={groups}
            naming={settings.itemTypes.naming}
            featureLevel={settings.itemTypes.featureLevel}
            onOpen={(item) => openPanel({ type: 'task', id: item.id })}
          />
          {canWrite ? (
            <div className="rounded-lg border border-border">
              <QuickCreateItem
                types={types}
                naming={settings.itemTypes.naming}
                featureLevel={settings.itemTypes.featureLevel}
                placeholder={copy.epicPage.addItem}
                onCreate={async ({ title, type }) => {
                  try {
                    await createItem.mutateAsync({ title, type, epicId });
                  } catch (error) {
                    toast.error(apiMessage(error, copy.quick.failed));
                    throw error;
                  }
                }}
              />
            </div>
          ) : null}
        </section>

        <aside className="min-w-0 space-y-6">
          <div className="rounded-lg border border-border p-4">
            <BurnupChart items={items} />
          </div>
          <EpicLinks links={linksQuery.data ?? []} loading={linksQuery.isLoading} failed={linksQuery.isError} projectId={projectId} />
          <section aria-labelledby="epic-description-heading" className="space-y-2 rounded-lg border border-border p-4">
            <h2 id="epic-description-heading" className="text-sm font-semibold">
              {copy.epicPage.description}
            </h2>
            {canWrite ? (
              <DescriptionField
                taskId={epic.id}
                description={epic.description ?? undefined}
                onUpdate={(_taskId, data) =>
                  updateEpic.mutate(buildTaskUpdatePayload(data), {
                    onError: (error) => toast.error(apiMessage(error, t.flowAgile.shared.saveFailed)),
                  })
                }
              />
            ) : (
              epic.description ? (
                <div className="text-sm [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: descriptionToHtml(epic.description) }} />
              ) : (
                <p className="text-sm text-muted-foreground">{copy.epicPage.noDescription}</p>
              )
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
