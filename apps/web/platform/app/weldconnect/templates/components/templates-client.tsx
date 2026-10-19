import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PencilLine, Play, Plug, Trash2 } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { usePermissions } from '@weldsuite/permissions/react';
import type { WorkflowTemplateItem } from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useCreateWorkflowFromTemplate,
  useDeleteTemplate,
  useUpdateTemplate,
  useWorkflowTemplates,
} from '@/hooks/queries/use-automation-queries';
import {
  EntityList,
  EmptyStateIllustration,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
  type HeaderColumn,
} from '@/components/entity-list';
import { setupCount, templateIcon } from '../template-utils';
import {
  ConnectListRow,
  ConnectRowCell,
  ConnectRowMenu,
  DESTRUCTIVE_MENU_ITEM,
  RowChip,
  RowText,
  RowTitle,
  StatusChip,
} from '../../components/connect-list-row';
import { TemplateDetailDialog, categoryLabel, integrationLabel } from './template-detail-dialog';
import { TemplateFormDialog, toTemplateCategory, type TemplateFormValues } from './template-form-dialog';

export function TemplatesClient() {
  const { t, language } = useI18n();
  const tt = t.weldconnect.templates;
  const router = useRouter();
  const { canAny } = usePermissions();
  const canEdit = canAny('workflow-templates:update', 'weldconnect:workflow-templates:update');
  const canDelete = canAny('workflow-templates:delete', 'weldconnect:workflow-templates:delete');

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.templates },
  ]);

  const { data, isLoading, error, refetch } = useWorkflowTemplates(language);
  const templates = useMemo(() => data?.data ?? [], [data]);
  const createFromTemplate = useCreateWorkflowFromTemplate();
  const updateTemplate = useUpdateTemplate();
  const deleteTemplate = useDeleteTemplate();

  const [selected, setSelected] = useState<WorkflowTemplateItem | null>(null);
  const [editing, setEditing] = useState<WorkflowTemplateItem | null>(null);
  const [deleting, setDeleting] = useState<WorkflowTemplateItem | null>(null);

  const { mutate: createWorkflowFromTemplate } = createFromTemplate;
  const handleUse = useCallback((template: WorkflowTemplateItem) => {
    createWorkflowFromTemplate(
      { templateId: template.id, locale: language },
      {
        onSuccess: (result) => {
          toast.success(tt.toasts.created.replace('{name}', template.name));
          setSelected(null);
          router.push(`/weldconnect/workflows/${result.data.id}/edit`);
        },
        onError: () => toast.error(tt.toasts.createFailed),
      },
    );
  }, [createWorkflowFromTemplate, language, router, tt]);

  const handleSaveDetails = (values: TemplateFormValues) => {
    if (!editing) return;
    updateTemplate.mutate(
      { id: editing.id, data: values },
      {
        onSuccess: () => {
          toast.success(tt.toasts.updated);
          setEditing(null);
          setSelected(null);
        },
        onError: () => toast.error(tt.toasts.updateFailed),
      },
    );
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deleteTemplate.mutateAsync(deleting.id);
      toast.success(tt.toasts.deleted);
      setDeleting(null);
      setSelected(null);
    } catch {
      toast.error(tt.toasts.deleteFailed);
    }
  };

  // Only the categories that have templates, in a stable order.
  const categories = useMemo(() => [...new Set(templates.map((template) => template.category))].sort(), [templates]);

  const filterConfigs: FilterConfig[] = useMemo(
    () => [
      {
        field: 'category',
        label: t.weldconnect.templatesClient.columnCategory,
        options: categories.map((category) => ({ value: category, label: categoryLabel(tt, category) })),
        getDisplayValue: (value) => categoryLabel(tt, value),
      },
    ],
    [t, tt, categories],
  );

  const groupConfigs: GroupConfig<WorkflowTemplateItem>[] = useMemo(
    () => [
      { id: 'workspace', label: tt.groups.workspace, filter: (item) => item.source === 'workspace', sortOrder: 1 },
      { id: 'builtin', label: tt.groups.builtin, filter: (item) => item.source === 'builtin', sortOrder: 2 },
    ],
    [tt],
  );

  const applyFilters = useCallback((items: WorkflowTemplateItem[], filters: ActiveFilter[]) => {
    let result = items;
    for (const filter of filters) {
      if (!filter.operator || !filter.value || filter.field !== 'category') continue;
      result =
        filter.operator === 'is'
          ? result.filter((item) => item.category === filter.value)
          : result.filter((item) => item.category !== filter.value);
    }
    return result;
  }, []);

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: t.weldconnect.templatesClient.columnTemplate, width: 'min-w-[280px] flex-1' },
      { id: 'category', header: t.weldconnect.templatesClient.columnCategory, width: 'w-[140px]' },
      { id: 'steps', header: tt.columnSteps, width: 'w-[90px]' },
      { id: 'setup', header: tt.columnSetup, width: 'w-[200px]' },
    ],
    [t, tt],
  );

  const renderRow = useCallback(
    (template: WorkflowTemplateItem) => {
      const Icon = templateIcon(template.icon);
      const toSetUp = setupCount(template);
      const isWorkspace = template.source === 'workspace';
      return (
        <ConnectListRow
          key={template.id}
          label={template.name}
          onOpen={() => setSelected(template)}
          menu={
            <ConnectRowMenu label={t.common.actions.openMenu}>
              <DropdownMenuItem onClick={() => handleUse(template)} disabled={createFromTemplate.isPending}>
                <Play className="mr-2 h-4 w-4" />
                {tt.useTemplate}
              </DropdownMenuItem>
              {isWorkspace && canEdit && (
                <DropdownMenuItem onClick={() => setEditing(template)}>
                  <PencilLine className="mr-2 h-4 w-4" />
                  {tt.editDetails}
                </DropdownMenuItem>
              )}
              {isWorkspace && canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setDeleting(template)} className={DESTRUCTIVE_MENU_ITEM}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    {tt.delete}
                  </DropdownMenuItem>
                </>
              )}
            </ConnectRowMenu>
          }
        >
          <ConnectRowCell width="min-w-[280px] flex-1">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[7px] bg-gray-200 text-gray-600 dark:bg-accent dark:text-muted-foreground">
              <Icon className="h-3 w-3" />
            </span>
            <RowTitle>{template.name}</RowTitle>
          </ConnectRowCell>

          <ConnectRowCell width="w-[140px]">
            <StatusChip tone="gray">{categoryLabel(tt, template.category)}</StatusChip>
          </ConnectRowCell>

          <ConnectRowCell width="w-[90px]">
            <RowText className="font-mono tabular-nums">{template.steps.length}</RowText>
          </ConnectRowCell>

          <ConnectRowCell width="w-[200px]" className="gap-1 overflow-hidden">
            {toSetUp > 0 ? (
              <RowChip tone="amber">{tt.needsSetupCount.replace('{count}', String(toSetUp))}</RowChip>
            ) : (
              <RowText>{tt.readyToUse}</RowText>
            )}
            {template.requiredIntegrations.map((provider) => (
              <RowChip key={provider} tone="blue" icon={<Plug />}>
                {integrationLabel(tt, provider)}
              </RowChip>
            ))}
          </ConnectRowCell>
        </ConnectListRow>
      );
    },
    [t, tt, canEdit, canDelete, createFromTemplate.isPending, handleUse],
  );

  if (error && !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">{tt.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {tt.retry}
        </Button>
      </div>
    );
  }

  return (
    <>
      <EntityList<WorkflowTemplateItem>
        items={templates}
        isLoading={isLoading}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={tt.searchPlaceholder}
        searchFields={['name', 'description']}
        noResultsState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="30" y="28" width="60" height="64" rx="6" className="fill-white dark:fill-secondary stroke-gray-200 dark:stroke-border" strokeWidth="1" />
                <rect x="40" y="40" width="40" height="4" rx="2" className="fill-gray-200 dark:fill-border" />
                <rect x="40" y="50" width="32" height="3" rx="1.5" className="fill-gray-200 dark:fill-border" opacity="0.6" />
                <rect x="40" y="58" width="36" height="3" rx="1.5" className="fill-gray-200 dark:fill-border" opacity="0.4" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: tt.noTemplates,
          description: tt.noTemplatesDescription,
        }}
      />

      <TemplateDetailDialog
        template={selected}
        onClose={() => setSelected(null)}
        onUse={handleUse}
        isUsing={createFromTemplate.isPending}
        canEdit={canEdit}
        canDelete={canDelete}
        onEditDetails={setEditing}
        onDelete={setDeleting}
      />

      <TemplateFormDialog
        open={!!editing}
        onOpenChange={(open) => !open && setEditing(null)}
        title={tt.editDialog.title}
        initialValues={{
          name: editing?.name ?? '',
          description: editing?.description ?? '',
          category: toTemplateCategory(editing?.category),
        }}
        submitLabel={tt.editDialog.save}
        submittingLabel={tt.editDialog.saving}
        isSubmitting={updateTemplate.isPending}
        onSubmit={handleSaveDetails}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tt.deleteDialog.title}
        description={tt.deleteDialog.description.replace('{name}', deleting?.name ?? '')}
        confirmLabel={tt.deleteDialog.confirm}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        loading={deleteTemplate.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
