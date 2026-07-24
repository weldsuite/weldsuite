
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link, useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import {
  Play,
  Pause,
  Edit,
  Trash2,
  Copy,
  RotateCcw,
} from 'lucide-react';
import {
  WorkflowListRow,
  type WorkflowListItem,
  type WorkflowListAction,
  type WorkflowTriggerVariant,
} from '@weldsuite/ui/components/workflow-list';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useDeleteWorkflow, useUpdateWorkflowStatus, useDuplicateWorkflow, useCreateWorkflow } from '@/hooks/queries/use-automation-queries';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';
import { ConfirmDialog } from '@/components/confirm-dialog';

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'draft' | 'archived';
  triggerType?: string;
  stepsCount?: number;
  executionCount: number;
  successRate?: number;
  lastExecutedAt: Date | null;
  createdAt: Date;
  updatedAt?: Date | null;
}

interface CreateTriggerOption {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  entityType: string;
  eventType: string;
  category?: string;
}

interface CreateTriggerCategory {
  id: string;
  label: string;
}

interface WorkflowsClientProps {
  initialWorkflows: Workflow[];
  initialStats?: {
    active: number;
    paused: number;
    draft: number;
    totalExecutions: number;
  };
  basePath?: string;
  apiBasePath?: string;
  entityLabel?: string;
  entityLabelPlural?: string;
  parentLabel?: string;
  parentHref?: string;
  showTemplatesButton?: boolean;
  showResetDefaults?: boolean;
  onSeedDefaults?: () => void;
  onResetDefaults?: () => void;
  isResetting?: boolean;
  category?: 'workflow' | 'sequence';
  onNewFromTemplate?: () => void;
  /** Override default status-based groups with custom trigger-based groups */
  triggerGroups?: GroupConfig<Workflow>[];
  /** Override default trigger filter options */
  triggerFilterOptions?: Array<{ value: string; label: string }>;
  /** Custom label function for trigger badge display */
  triggerLabelFn?: (triggerType: string) => string;
  /** When provided, the create dialog requires selecting a trigger before creating */
  createTriggerOptions?: CreateTriggerOption[];
  /** Optional categories to group trigger options */
  createTriggerCategories?: CreateTriggerCategory[];
  /** Map of trigger keys already taken by active workflows (key → workflow name) */
  takenTriggers?: Map<string, string>;
}

// Trigger type → shared-component color variant. Labels are resolved from
// i18n inside the component (see `triggerLabels`).
const triggerConfig: Record<string, { variant: WorkflowTriggerVariant }> = {
  manual: { variant: 'manual' },
  schedule: { variant: 'schedule' },
  webhook: { variant: 'webhook' },
};

export function WorkflowsClient({
  initialWorkflows,
  // initialStats is accepted for API-compatibility with callers that compute
  // it, but this view doesn't currently render a stats summary.
  basePath = '/weldconnect/workflows',
  apiBasePath = '/workflows',
  entityLabel = 'Workflow',
  entityLabelPlural = 'Workflows',
  parentLabel = 'Task',
  parentHref = '/weldconnect',
  showTemplatesButton = true,
  showResetDefaults = false,
  onSeedDefaults,
  onResetDefaults,
  isResetting = false,
  category,
  onNewFromTemplate,
  triggerGroups,
  triggerFilterOptions,
  triggerLabelFn,
  createTriggerOptions,
  createTriggerCategories,
  takenTriggers,
}: WorkflowsClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  useBreadcrumbs([
    { label: parentLabel, href: parentHref },
    { label: entityLabelPlural },
  ]);

  // Fallback trigger labels (used when triggerLabelFn isn't provided).
  const triggerLabels: Record<string, string> = useMemo(() => ({
    manual: t.weldconnect.workflows.triggerTypes.manual,
    schedule: t.weldconnect.workflows.triggerTypes.schedule,
    webhook: t.weldconnect.workflows.triggerTypes.webhook,
  }), [t]);

  const router = useRouter();
  const [workflows, setWorkflows] = useState<Workflow[]>(initialWorkflows);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sync local state when parent data changes (e.g. after refetch). Also prune
  // any selected ids that no longer exist in the latest data set.
  useEffect(() => {
    setWorkflows(initialWorkflows);
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(initialWorkflows.map((w) => w.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [initialWorkflows]);
  const [newWorkflowName, setNewWorkflowName] = useState('');
  const [selectedCreateTrigger, setSelectedCreateTrigger] = useState<CreateTriggerOption | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const deleteWorkflowMutation = useDeleteWorkflow(apiBasePath);
  const updateStatusMutation = useUpdateWorkflowStatus(apiBasePath);
  const duplicateWorkflowMutation = useDuplicateWorkflow(apiBasePath);
  const createWorkflowMutation = useCreateWorkflow(apiBasePath);
  const isCreating = createWorkflowMutation.isPending;

  // Format date
  const formatDate = useCallback((date: Date | null) => {
    if (!date) return '—';
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 60) {
      return st('sweep.weldconnect.workflowsClient.minutesAgoShort', { count: diffMinutes });
    } else if (diffHours < 24) {
      return st('sweep.weldconnect.workflowsClient.hoursAgoShort', { count: diffHours });
    } else if (diffDays < 30) {
      return st('sweep.weldconnect.workflowsClient.daysAgoShort', { count: diffDays });
    } else {
      return d.toLocaleDateString();
    }
  }, [st]);

  const handleDelete = useCallback((workflowId: string) => {
    setDeleteConfirm(workflowId);
  }, []);

  const confirmDelete = () => {
    if (!deleteConfirm) return;
    deleteWorkflowMutation.mutate(deleteConfirm, {
      onSuccess: () => {
        setWorkflows(workflows.filter(w => w.id !== deleteConfirm));
        setDeleteConfirm(null);
        toast.success(t.weldconnect.workflows.toasts.deleted.replace('{entityLabel}', entityLabel));
      },
      onError: () => {
        toast.error(t.weldconnect.workflows.toasts.deleteFailed.replace('{entityLabel}', entityLabel.toLowerCase()));
      },
    });
  };

  // --- Multi-select / bulk delete ---
  const toggleSelect = useCallback((workflowId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(workflowId);
      else next.delete(workflowId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const allSelected = workflows.length > 0 && selectedIds.size === workflows.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleSelectAll = useCallback((checked: boolean) => {
    setSelectedIds(checked ? new Set(workflows.map((w) => w.id)) : new Set());
  }, [workflows]);

  const confirmBulkDelete = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    const results = await Promise.allSettled(
      ids.map((id) => deleteWorkflowMutation.mutateAsync(id)),
    );
    const succeeded = new Set(
      ids.filter((_, i) => results[i]?.status === 'fulfilled'),
    );
    const failedCount = ids.length - succeeded.size;

    setWorkflows((prev) => prev.filter((w) => !succeeded.has(w.id)));
    setSelectedIds((prev) => new Set([...prev].filter((id) => !succeeded.has(id))));
    setIsBulkDeleting(false);
    setShowBulkDeleteConfirm(false);

    const labelPlural = entityLabelPlural.toLowerCase();
    if (failedCount === 0) {
      toast.success(
        t.weldconnect.workflows.bulk.deleted
          .replace('{count}', String(succeeded.size))
          .replace('{entityLabel}', labelPlural),
      );
    } else if (succeeded.size > 0) {
      toast.warning(
        t.weldconnect.workflows.bulk.partial
          .replace('{success}', String(succeeded.size))
          .replace('{count}', String(ids.length))
          .replace('{entityLabel}', labelPlural),
      );
    } else {
      toast.error(
        t.weldconnect.workflows.bulk.deleteFailed.replace('{entityLabel}', labelPlural),
      );
    }
  };

  const handleActivate = useCallback((workflowId: string) => {
    updateStatusMutation.mutate({ id: workflowId, status: 'active' }, {
      onSuccess: () => {
        setWorkflows((prev) => prev.map(w =>
          w.id === workflowId ? { ...w, status: 'active' as const } : w
        ));
        toast.success(t.weldconnect.workflows.toasts.activated);
      },
      onError: () => {
        toast.error(t.weldconnect.workflows.toasts.activateFailed);
      },
    });
  }, [updateStatusMutation, t.weldconnect.workflows.toasts.activated, t.weldconnect.workflows.toasts.activateFailed]);

  const handlePause = useCallback((workflowId: string) => {
    updateStatusMutation.mutate({ id: workflowId, status: 'paused' }, {
      onSuccess: () => {
        setWorkflows((prev) => prev.map(w =>
          w.id === workflowId ? { ...w, status: 'paused' as const } : w
        ));
        toast.success(t.weldconnect.workflows.toasts.paused);
      },
      onError: () => {
        toast.error(t.weldconnect.workflows.toasts.pauseFailed);
      },
    });
  }, [updateStatusMutation, t.weldconnect.workflows.toasts.paused, t.weldconnect.workflows.toasts.pauseFailed]);

  const handleDuplicate = useCallback((workflow: Workflow) => {
    duplicateWorkflowMutation.mutate({ id: workflow.id }, {
      onSuccess: () => {
        toast.success(t.weldconnect.workflows.toasts.duplicated);
      },
      onError: () => {
        toast.error(t.weldconnect.workflows.toasts.duplicateFailed);
      },
    });
  }, [duplicateWorkflowMutation, t.weldconnect.workflows.toasts.duplicated, t.weldconnect.workflows.toasts.duplicateFailed]);

  const handleCreateWorkflow = () => {
    if (!newWorkflowName.trim()) return;
    if (createTriggerOptions && !selectedCreateTrigger) return;

    const payload: Parameters<typeof createWorkflowMutation.mutate>[0] = {
      name: newWorkflowName.trim(),
    };

    if (selectedCreateTrigger) {
      payload.triggers = [{
        id: `trigger-${Date.now()}`,
        type: 'entity_event',
        isEnabled: true,
        entityType: selectedCreateTrigger.entityType,
        eventType: selectedCreateTrigger.eventType,
        name: selectedCreateTrigger.label,
      }];
    }

    createWorkflowMutation.mutate(payload, {
      onSuccess: (data) => {
        setShowCreateDialog(false);
        setNewWorkflowName('');
        setSelectedCreateTrigger(null);
        if (data?.data?.id) {
          router.push(`${basePath}/${data.data.id}/edit`);
        }
      },
      onError: () => {
        toast.error(t.weldconnect.workflows.toasts.createFailed);
      },
    });
  };

  const handleNewWorkflow = async () => {
    try {
      const result = await createWorkflowMutation.mutateAsync({ name: 'Untitled workflow' });
      if (result?.data?.id) {
        router.push(`${basePath}/${result.data.id}/edit`);
      }
    } catch {
      toast.error(t.weldconnect.workflows.toasts.createFailed);
    }
  };

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.weldconnect.workflows.filters.status,
      options: [
        { value: 'active', label: t.weldconnect.workflows.statuses.active },
        { value: 'paused', label: t.weldconnect.workflows.statuses.paused },
        { value: 'draft', label: t.weldconnect.workflows.statuses.draft },
      ],
    },
    {
      field: 'triggerType',
      label: t.weldconnect.workflows.filters.trigger,
      options: triggerFilterOptions || [
        { value: 'schedule', label: t.weldconnect.workflows.triggerTypes.schedule },
        { value: 'webhook', label: t.weldconnect.workflows.triggerTypes.webhook },
        { value: 'manual', label: t.weldconnect.workflows.triggerTypes.manual },
      ],
    },
  ], [triggerFilterOptions, t]);

  // Group configs — use trigger-based groups if provided, otherwise group by status
  const groupConfigs: GroupConfig<Workflow>[] = useMemo(() => {
    if (triggerGroups && triggerGroups.length > 0) {
      return triggerGroups;
    }
    return [
      {
        id: 'draft',
        label: t.weldconnect.workflows.statuses.draft,
        sortOrder: 1,
        filter: (w) => w.status === 'draft',
      },
      {
        id: 'active',
        label: t.weldconnect.workflows.statuses.active,
        sortOrder: 2,
        filter: (w) => w.status === 'active',
      },
      {
        id: 'paused',
        label: t.weldconnect.workflows.statuses.paused,
        sortOrder: 3,
        filter: (w) => w.status === 'paused',
      },
    ];
  }, [triggerGroups, t]);

  // Apply filters
  const applyFilters = useCallback((items: Workflow[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(w => w.status === filter.value)
          : result.filter(w => w.status !== filter.value);
      } else if (filter.field === 'triggerType') {
        result = filter.operator === 'is'
          ? result.filter(w => w.triggerType?.toLowerCase() === filter.value)
          : result.filter(w => w.triggerType?.toLowerCase() !== filter.value);
      }
    });

    return result;
  }, []);

  // Header columns. A leading empty cell keeps the header aligned with the
  // per-row selection checkbox.
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'select', header: '', width: 'w-4' },
    { id: 'name', header: entityLabel, width: 'flex-1 min-w-[250px]' },
    { id: 'trigger', header: t.weldconnect.workflows.columns.trigger, width: 'w-[120px]' },
    { id: 'status', header: t.weldconnect.workflows.columns.status, width: 'w-[110px]' },
    { id: 'lastModified', header: t.weldconnect.workflows.columns.lastModified, width: 'w-[120px]' },
  ], [entityLabel, t]);

  // For workflows, the row opens the conversational builder; the visual editor
  // is still reachable from the builder's "Open in editor" button and from the
  // dropdown's "Open in editor" item.
  const rowOpenPath = useCallback((id: string) =>
    category === 'workflow' ? `${basePath}/${id}` : `${basePath}/${id}/edit`,
  [category, basePath]);

  // Render row — the visual shell comes from the shared @weldsuite/ui
  // WorkflowListRow; this maps the domain Workflow onto its props.
  const renderRow = useCallback((workflow: Workflow) => {
    const triggerKey = workflow.triggerType?.toLowerCase() || 'manual';
    const item: WorkflowListItem = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      triggerLabel: triggerLabelFn
        ? triggerLabelFn(workflow.triggerType || '')
        : triggerLabels[triggerKey] || workflow.triggerType || triggerLabels.manual,
      // Custom trigger labels render in the teal "event" style, matching the
      // previous design; otherwise use the per-type color.
      triggerVariant: triggerLabelFn
        ? 'event'
        : triggerConfig[triggerKey]?.variant || 'manual',
      lastActivityLabel: formatDate(workflow.updatedAt ?? null),
    };

    const actions: WorkflowListAction[] = [
      {
        id: 'open',
        label: category === 'workflow'
          ? t.weldconnect.workflows.actions.open
          : t.weldconnect.workflows.actions.edit,
        icon: Edit,
        onSelect: () => router.push(rowOpenPath(workflow.id)),
      },
      ...(category === 'workflow'
        ? [{
            id: 'open-visual',
            label: t.weldconnect.workflows.actions.openInVisualEditor,
            icon: Edit,
            onSelect: () => router.push(`${basePath}/${workflow.id}/edit`),
          } satisfies WorkflowListAction]
        : []),
      {
        id: 'duplicate',
        label: t.weldconnect.workflows.actions.duplicate,
        icon: Copy,
        onSelect: () => handleDuplicate(workflow),
      },
      {
        id: 'activate',
        label: t.weldconnect.workflows.actions.activate,
        icon: Play,
        separatorBefore: true,
        hidden: () => workflow.status === 'active',
        onSelect: () => handleActivate(workflow.id),
      },
      {
        id: 'pause',
        label: t.weldconnect.workflows.actions.pause,
        icon: Pause,
        separatorBefore: true,
        hidden: () => workflow.status !== 'active',
        onSelect: () => handlePause(workflow.id),
      },
      {
        id: 'delete',
        label: t.weldconnect.workflows.actions.delete,
        icon: Trash2,
        separatorBefore: true,
        destructive: true,
        onSelect: () => handleDelete(workflow.id),
      },
    ];

    return (
      <WorkflowListRow
        key={workflow.id}
        item={item}
        actions={actions}
        onSelectItem={() => router.push(rowOpenPath(workflow.id))}
        selectable
        selected={selectedIds.has(workflow.id)}
        onSelectChange={(checked) => toggleSelect(workflow.id, checked)}
      />
    );
  }, [router, basePath, category, t, triggerLabels, handleDelete, handleActivate, handlePause, handleDuplicate, triggerLabelFn, selectedIds, toggleSelect, formatDate, rowOpenPath]);

  return (
    <>
      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}
        title={t.weldconnect.workflows.deleteConfirm.title.replace('{entityLabel}', entityLabel)}
        description={t.weldconnect.workflows.deleteConfirm.description.replace('{entityLabel}', entityLabel.toLowerCase())}
        confirmLabel={t.weldconnect.workflows.deleteConfirm.confirmLabel}
        variant="destructive"
        loading={deleteWorkflowMutation.isPending}
        onConfirm={confirmDelete}
      />

      {/* Bulk Delete Confirm */}
      <ConfirmDialog
        open={showBulkDeleteConfirm}
        onOpenChange={(open) => { if (!open) setShowBulkDeleteConfirm(false); }}
        title={t.weldconnect.workflows.bulk.confirmTitle
          .replace('{count}', String(selectedIds.size))
          .replace('{entityLabel}', entityLabelPlural.toLowerCase())}
        description={t.weldconnect.workflows.bulk.confirmDescription
          .replace('{count}', String(selectedIds.size))
          .replace('{entityLabel}', entityLabelPlural.toLowerCase())}
        confirmLabel={t.weldconnect.workflows.bulk.confirmLabel}
        variant="destructive"
        loading={isBulkDeleting}
        onConfirm={confirmBulkDelete}
      />

      {/* Reset Defaults Confirm */}
      {showResetDefaults && (
        <ConfirmDialog
          open={showResetConfirm}
          onOpenChange={setShowResetConfirm}
          title={t.weldconnect.workflows.resetDefaults.title}
          description={t.weldconnect.workflows.resetDefaults.description}
          confirmLabel={t.weldconnect.workflows.resetDefaults.confirmLabel}
          variant="destructive"
          loading={isResetting}
          onConfirm={() => {
            onResetDefaults?.();
            setShowResetConfirm(false);
          }}
        />
      )}

      {/* Create Workflow Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => {
        setShowCreateDialog(open);
        if (!open) { setNewWorkflowName(''); setSelectedCreateTrigger(null); }
      }}>
        <DialogContent className={cn("sm:max-w-[400px]", createTriggerOptions && "sm:max-w-[480px]")}>
          <DialogHeader>
            <DialogTitle>{t.weldconnect.workflows.dialogs.createTitle.replace('{entityLabel}', entityLabel)}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="workflow-name" className="text-sm">
                {t.weldconnect.workflows.dialogs.nameLabel.replace('{entityLabel}', entityLabel)}
              </Label>
              <Input
                id="workflow-name"
                placeholder={t.weldconnect.workflows.dialogs.namePlaceholder.replace('{entityLabel}', entityLabel.toLowerCase())}
                value={newWorkflowName}
                onChange={(e) => setNewWorkflowName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newWorkflowName.trim() && (!createTriggerOptions || selectedCreateTrigger)) {
                    handleCreateWorkflow();
                  }
                }}
                autoFocus
              />
            </div>

            {createTriggerOptions && (
              <div className="grid gap-2">
                <Label className="text-sm">{t.weldconnect.workflows.dialogs.triggerLabel} <span className="text-red-500">*</span></Label>
                <div className="max-h-[320px] overflow-y-auto rounded-lg border p-1.5 space-y-3">
                  {createTriggerCategories && createTriggerCategories.length > 0 ? (
                    createTriggerCategories.map((cat) => {
                      const catOptions = createTriggerOptions.filter((o) => o.category === cat.id);
                      if (catOptions.length === 0) return null;
                      return (
                        <div key={cat.id}>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1">
                            {cat.label}
                          </p>
                          <div className="space-y-0.5">
                            {catOptions.map((opt) => {
                              const key = `${opt.entityType}:${opt.eventType}`;
                              const taken = takenTriggers?.get(key);
                              const isSelected = selectedCreateTrigger?.id === opt.id;
                              const Icon = opt.icon;
                              return (
                                <Button
                                  key={opt.id}
                                  type="button"
                                  variant="ghost"
                                  disabled={!!taken}
                                  onClick={() => setSelectedCreateTrigger(isSelected ? null : opt)}
                                  className={cn(
                                    'flex items-start gap-2.5 w-full py-2 px-2.5 rounded-lg transition-all text-left',
                                    taken
                                      ? 'opacity-40 cursor-not-allowed'
                                      : isSelected
                                        ? 'bg-teal-50 dark:bg-teal-950/40 ring-1 ring-teal-200 dark:ring-teal-800'
                                        : 'hover:bg-muted',
                                  )}
                                >
                                  <div className={cn(
                                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md mt-0.5',
                                    isSelected ? 'bg-teal-100 dark:bg-teal-900/40' : 'bg-muted',
                                  )}>
                                    <Icon className={cn('w-3.5 h-3.5', isSelected ? 'text-teal-600' : 'text-muted-foreground')} />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <span className={cn('text-sm block leading-snug', isSelected ? 'text-teal-700 dark:text-teal-300 font-medium' : 'font-medium')}>
                                      {opt.label}
                                    </span>
                                    {opt.description && (
                                      <span className="text-[11px] text-muted-foreground block mt-0.5 leading-snug">
                                        {opt.description}
                                      </span>
                                    )}
                                    {taken && (
                                      <span className="block text-[10px] text-orange-600 dark:text-orange-400 mt-0.5 truncate">{t.weldconnect.workflows.dialogs.activeIn.replace('{name}', taken)}</span>
                                    )}
                                  </div>
                                </Button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    // Flat list fallback (no categories)
                    createTriggerOptions.map((opt) => {
                      const key = `${opt.entityType}:${opt.eventType}`;
                      const taken = takenTriggers?.get(key);
                      const isSelected = selectedCreateTrigger?.id === opt.id;
                      const Icon = opt.icon;
                      return (
                        <Button
                          key={opt.id}
                          type="button"
                          variant="ghost"
                          disabled={!!taken}
                          onClick={() => setSelectedCreateTrigger(isSelected ? null : opt)}
                          className={cn(
                            'flex items-start gap-2.5 w-full py-2 px-2.5 rounded-lg transition-all text-left',
                            taken
                              ? 'opacity-40 cursor-not-allowed'
                              : isSelected
                                ? 'bg-teal-50 dark:bg-teal-950/40 ring-1 ring-teal-200 dark:ring-teal-800'
                                : 'hover:bg-muted',
                          )}
                        >
                          <div className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md mt-0.5',
                            isSelected ? 'bg-teal-100 dark:bg-teal-900/40' : 'bg-muted',
                          )}>
                            <Icon className={cn('w-3.5 h-3.5', isSelected ? 'text-teal-600' : 'text-muted-foreground')} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className={cn('text-sm block leading-snug', isSelected ? 'text-teal-700 dark:text-teal-300 font-medium' : 'font-medium')}>
                              {opt.label}
                            </span>
                            {opt.description && (
                              <span className="text-[11px] text-muted-foreground block mt-0.5 leading-snug">
                                {opt.description}
                              </span>
                            )}
                            {taken && (
                              <span className="block text-[10px] text-orange-600 dark:text-orange-400 mt-0.5 truncate">{t.weldconnect.workflows.dialogs.activeIn.replace('{name}', taken)}</span>
                            )}
                          </div>
                        </Button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t.weldconnect.variables.dialog.cancel}
            </Button>
            <Button
              onClick={handleCreateWorkflow}
              disabled={!newWorkflowName.trim() || (!!createTriggerOptions && !selectedCreateTrigger) || isCreating}
            >
              {isCreating ? t.weldconnect.variables.dialog.creating : t.weldconnect.workflows.createWorkflow}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk selection toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-3 md:px-4 h-[53px] border-b border-border bg-muted/40">
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={(checked) => toggleSelectAll(checked === true)}
            aria-label={t.weldconnect.workflows.bulk.selectAll}
          />
          <span className="text-sm font-medium">
            {t.weldconnect.workflows.bulk.selected.replace('{count}', String(selectedIds.size))}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-8" onClick={clearSelection}>
              {t.weldconnect.workflows.bulk.clear}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8"
              onClick={() => setShowBulkDeleteConfirm(true)}
              disabled={isBulkDeleting}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {t.weldconnect.workflows.bulk.delete} ({selectedIds.size})
            </Button>
          </div>
        </div>
      )}

      <EntityList<Workflow>
        items={workflows}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        onDeleteItem={handleDelete}
        onDuplicateItem={handleDuplicate}
        searchPlaceholder={t.weldconnect.workflowsClient.searchPlaceholder.replace('{entityLabel}', entityLabelPlural.toLowerCase())}
        searchFields={['name', 'description']}
        actionButtons={(showResetDefaults || showTemplatesButton || onNewFromTemplate) ? (
          <div className="flex gap-2">
            {showResetDefaults && onResetDefaults && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setShowResetConfirm(true)}
                disabled={isResetting}
              >
                <RotateCcw className={cn("h-3.5 w-3.5 mr-1", isResetting && "animate-spin")} />
                {isResetting ? t.weldconnect.workflows.resetDefaults.confirmLabel : t.weldconnect.workflows.resetDefaults.confirmLabel}
              </Button>
            )}
            {onNewFromTemplate && (
              <Button variant="outline" size="sm" className="h-8" onClick={onNewFromTemplate}>
                {t.weldconnect.templates.title}
              </Button>
            )}
            {showTemplatesButton && (
              <Button variant="outline" size="sm" className="h-8" asChild>
                <Link href="/weldconnect/templates">
                  {t.weldconnect.templates.title}
                </Link>
              </Button>
            )}
          </div>
        ) : undefined}
        createButton={
          category === 'workflow'
            ? {
                label: t.weldconnect.workflowsClient.createButton.replace('{entityLabel}', entityLabel.toLowerCase()),
                onClick: handleNewWorkflow,
              }
            : {
                label: t.weldconnect.workflowsClient.createButtonAlt.replace('{entityLabel}', entityLabel),
                onClick: () => setShowCreateDialog(true),
              }
        }
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="140" height="120" viewBox="0 0 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Bezier connections */}
                <path d="M46 32L46 38C46 44 52 44 58 44L62 44" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
                <path d="M108 50L112 50C118 50 118 56 118 62L118 66C118 72 112 72 106 72L80 72" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
                <path d="M42 78L38 78C32 78 32 84 32 90L32 92C32 98 38 98 44 98L58 98" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
                {/* Arrow dots at connection ends */}
                <circle cx="62" cy="44" r="2" className="fill-gray-200 dark:fill-border" />
                <circle cx="80" cy="72" r="2" className="fill-gray-200 dark:fill-border" />
                <circle cx="58" cy="98" r="2" className="fill-gray-200 dark:fill-border" />
                {/* Card 1 — Trigger */}
                <rect x="22" y="14" width="48" height="18" rx="5" className="fill-white dark:fill-secondary" />
                <rect x="22" y="14" width="48" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
                <rect x="30" y="21" width="20" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
                <rect x="53" y="21" width="10" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.3" />
                {/* Card 2 — Action */}
                <rect x="62" y="36" width="48" height="18" rx="5" className="fill-white dark:fill-secondary" />
                <rect x="62" y="36" width="48" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
                <rect x="70" y="43" width="24" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
                <rect x="97" y="43" width="6" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.3" />
                {/* Card 3 — Condition */}
                <rect x="42" y="64" width="38" height="18" rx="5" className="fill-white dark:fill-secondary" />
                <rect x="42" y="64" width="38" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
                <rect x="50" y="71" width="18" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
                {/* Card 4 — End */}
                <rect x="58" y="90" width="48" height="18" rx="5" className="fill-white dark:fill-secondary" />
                <rect x="58" y="90" width="48" height="18" rx="5" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />
                <rect x="66" y="97" width="28" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.5" />
                <rect x="97" y="97" width="4" height="2.5" rx="1.25" className="fill-gray-200 dark:fill-border" opacity="0.3" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.weldconnect.workflowsClient.emptyTitle.replace('{entityLabel}', entityLabelPlural.toLowerCase()),
          description: onSeedDefaults
            ? t.weldconnect.workflowsClient.emptyDescriptionDefault
            : category === 'workflow'
              ? t.weldconnect.workflowsClient.emptyDescriptionWorkflow
              : t.weldconnect.workflowsClient.emptyDescriptionEntity.replace('{entityLabel}', entityLabel.toLowerCase()),
          action: onSeedDefaults
            ? { label: t.weldconnect.workflowsClient.loadDefaultsButton, onClick: onSeedDefaults }
            : category === 'workflow'
              ? { label: t.weldconnect.workflowsClient.createButton.replace('{entityLabel}', entityLabel.toLowerCase()), onClick: handleNewWorkflow }
              : { label: t.weldconnect.workflowsClient.createButtonAlt.replace('{entityLabel}', entityLabel), onClick: () => setShowCreateDialog(true) },
          secondaryAction: onSeedDefaults
            ? { label: t.weldconnect.workflowsClient.createButton.replace('{entityLabel}', entityLabel.toLowerCase()), onClick: handleNewWorkflow }
            : undefined,
        }}
        noResultsState={{
          title: t.weldconnect.workflowsClient.noResultsTitle.replace('{entityLabel}', entityLabelPlural.toLowerCase()),
          description: t.weldconnect.workflowsClient.noResultsDescription.replace('{entityLabel}', entityLabelPlural.toLowerCase()),
        }}
      />
    </>
  );
}
