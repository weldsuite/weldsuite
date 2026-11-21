/**
 * WeldDesk service catalogue settings: the items in the order readers see them
 * (move up / down, switch on or off, edit, delete) and the item editor. Items
 * are `/api/desk/catalog` rows (desk-api); the rules are
 * `@weldsuite/db/lib/desk-catalog`.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ConciergeBell, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { LucideDynamicIcon } from '@weldsuite/ui/components/lucide-dynamic-icon';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { getTranslations } from '@/lib/i18n';
import { useTicketTypes } from '@/hooks/queries/use-helpdesk-queries';
import { useDeskTeamMembers, useDeskTeams } from '@/hooks/queries/use-desk-routing-queries';
import {
  deskCatalogErrorMessage,
  deskCatalogRefusal,
  deskCatalogRefusalCount,
  useCreateDeskCatalogItem,
  useDeleteDeskCatalogItem,
  useDeskCatalogItems,
  useUpdateDeskCatalogItem,
  type DeskCatalogItem,
} from '@/hooks/queries/use-desk-catalog-queries';
import { CatalogItemEditor, type CatalogEditorOptions } from './catalog-item-editor';
import { approverSummary, categoriesOf, reorderPatches, valuesToInput, type CatalogFormValues } from './catalog-form';

export function CatalogSettings() {
  const t = getTranslations('deskCatalog').settings;
  const canEdit = useCan('welddesk:settings:update');
  const { data: items, isLoading, isError, refetch } = useDeskCatalogItems({ all: true });
  const { data: types = [] } = useTicketTypes();
  const { data: teams = [] } = useDeskTeams();
  const { data: members = [] } = useDeskTeamMembers();
  const create = useCreateDeskCatalogItem();
  const update = useUpdateDeskCatalogItem();
  const remove = useDeleteDeskCatalogItem();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DeskCatalogItem | null>(null);
  const [deleting, setDeleting] = useState<DeskCatalogItem | null>(null);
  const [ordering, setOrdering] = useState(false);

  const list = useMemo(() => items ?? [], [items]);

  const options: CatalogEditorOptions = useMemo(
    () => ({
      ticketTypes: types
        .filter((type) => (type.category ?? 'customer') === 'customer' && type.isActive !== false)
        .map((type) => ({ value: type.id, label: type.name })),
      teams: teams.filter((team) => team.isActive).map((team) => ({ value: team.id, label: team.name })),
      members: members.map((member) => ({ value: member.userId, label: member.name })),
      categories: categoriesOf(list),
    }),
    [types, teams, members, list],
  );

  const names = useMemo(() => {
    const typeName = new Map(types.map((type) => [type.id, type.name]));
    const teamName = new Map(teams.map((team) => [team.id, team.name]));
    const memberName = new Map(members.map((member) => [member.userId, member.name]));
    return {
      type: (id: string) => typeName.get(id),
      team: (id: string) => teamName.get(id),
      member: (id: string) => memberName.get(id),
    };
  }, [types, teams, members]);

  const saving = create.isPending || update.isPending;

  const onSave = async (values: CatalogFormValues): Promise<boolean> => {
    const input = valuesToInput(values);
    try {
      if (editing) await update.mutateAsync({ id: editing.id, ...input });
      else await create.mutateAsync({ ...input, sortOrder: list.length });
      toast.success(editing ? t.toast.saved : t.toast.created);
      return true;
    } catch (err) {
      toast.error(deskCatalogErrorMessage(err) ?? t.toast.saveFailed);
      return false;
    }
  };

  const toggleActive = async (item: DeskCatalogItem, isActive: boolean) => {
    try {
      await update.mutateAsync({ id: item.id, isActive });
    } catch (err) {
      toast.error(deskCatalogErrorMessage(err) ?? t.toast.saveFailed);
    }
  };

  const move = async (index: number, by: -1 | 1) => {
    const patches = reorderPatches(list, index, by);
    if (patches.length === 0) return;
    setOrdering(true);
    try {
      await Promise.all(patches.map((patch) => update.mutateAsync(patch)));
    } catch {
      toast.error(t.toast.orderFailed);
    } finally {
      setOrdering(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(t.toast.deleted);
      setDeleting(null);
    } catch (err) {
      if (deskCatalogRefusal(err) === 'has_pending_requests') {
        // Requests of this item wait for a decision: the item stays, the dialog closes.
        const count = deskCatalogRefusalCount(err) ?? 0;
        toast.error(count === 1 ? t.toast.inUseOne : t.toast.inUseOther.replace('{count}', String(count)));
        setDeleting(null);
        return;
      }
      toast.error(deskCatalogErrorMessage(err) ?? t.toast.saveFailed);
    }
  };

  const openEditor = (item: DeskCatalogItem | null) => {
    setEditing(item);
    setEditorOpen(true);
  };

  const labels = {
    managerOf: t.list.managerOf,
    requestTeamManager: t.list.requestTeamManager,
    unknownMember: t.list.unknownMember,
  };

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = <ErrorState message={t.loadError} onRetry={() => void refetch()} />;
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon={ConciergeBell}
        title={t.empty.title}
        description={t.empty.description}
        action={
          canEdit ? (
            <Button onClick={() => openEditor(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newItem}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="catalog-item-list">
        {list.map((item, index) => {
          const typeName = names.type(item.ticketTypeId);
          const taskCount = item.fulfilmentTasks.length;
          let tasksLabel = t.list.noTasks;
          if (taskCount === 1) tasksLabel = t.list.tasksOne;
          else if (taskCount > 1) tasksLabel = t.list.tasksOther.replace('{count}', String(taskCount));
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap" data-testid="catalog-item-row">
              <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground" title={t.list.orderTitle}>
                {index + 1}
              </span>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {item.icon ? <LucideDynamicIcon name={item.icon} className="h-4 w-4" /> : <ConciergeBell className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{item.name}</span>
                  {item.category && <SoftBadge tone="neutral">{item.category}</SoftBadge>}
                  {!item.isActive && <SoftBadge tone="warning">{t.list.inactiveBadge}</SoftBadge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {typeName ? t.list.form.replace('{name}', typeName) : t.list.formMissing}
                  {' · '}
                  {item.approvalSteps.length === 0
                    ? t.list.noApproval
                    : t.list.approvalBy.replace('{names}', approverSummary(item.approvalSteps, names, labels))}
                  {' · '}
                  {tasksLabel}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {canEdit && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={index === 0 || ordering}
                      onClick={() => void move(index, -1)}
                      aria-label={t.list.moveUp.replace('{name}', item.name)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={index === list.length - 1 || ordering}
                      onClick={() => void move(index, 1)}
                      aria-label={t.list.moveDown.replace('{name}', item.name)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <Switch
                  checked={item.isActive}
                  disabled={!canEdit || update.isPending}
                  onCheckedChange={(on) => void toggleActive(item, on)}
                  aria-label={t.list.activeToggle.replace('{name}', item.name)}
                />
                {canEdit && (
                  <>
                    <Button variant="ghost" size="icon" onClick={() => openEditor(item)} aria-label={t.list.edit.replace('{name}', item.name)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(item)} aria-label={t.list.delete.replace('{name}', item.name)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6" data-testid="catalog-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          {canEdit && list.length > 0 && (
            <Button onClick={() => openEditor(null)} data-testid="catalog-item-new">
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newItem}
            </Button>
          )}
        </div>

        <InfoBanner variant="info">{t.appliesNote}</InfoBanner>
        {body}
      </div>

      <CatalogItemEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        item={editing}
        options={options}
        saving={saving}
        onSave={onSave}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.delete.title}
        description={t.delete.description.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.delete.confirm}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
