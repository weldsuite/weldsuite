
import { useState, useMemo, useCallback } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  EllipsisVertical,
  Key,
  Lock,
  Globe,
  GitBranch,
  Edit,
  Trash2,
  Variable as VariableIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useDeleteVariable } from '@/hooks/queries/use-automation-queries';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { VariableDialog } from './variable-dialog';
import { asText } from '@weldsuite/text';

export interface Variable {
  id: string;
  name: string;
  description?: string;
  value: unknown;
  type: string;
  scope: 'global' | 'workflow' | 'execution';
  isSecret: boolean;
  workflowId?: string;
  createdAt: string;
}

interface VariablesClientProps {
  initialVariables: Variable[];
  isLoading?: boolean;
  /** Workflow id → name, for workflow-scoped variables. */
  workflowNames?: Record<string, string>;
}

// Header and row cells share these. Name and Value take the free space and
// truncate; the narrow columns never shrink (a shrinking fixed-width Value cell
// ended up ~48px wide), and Created drops out below `xl` to make room.
const COLUMN_WIDTHS = {
  name: 'min-w-[160px] flex-1',
  value: 'min-w-[140px] flex-1',
  type: 'w-[90px] shrink-0',
  scope: 'w-[110px] shrink-0',
  created: 'hidden xl:block w-[100px] shrink-0',
  actions: 'w-[48px] shrink-0',
} as const;

const scopeClassConfig: Record<string, { icon: React.ElementType; className: string }> = {
  global: {
    icon: Globe,
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  },
  workflow: {
    icon: GitBranch,
    className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  },
  execution: {
    icon: Key,
    className: 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground',
  },
};

// A secret's value never leaves the server (the API masks it), so there is
// nothing to reveal here. The full text is returned: the cell truncates it
// with CSS to whatever width the table has, and shows all of it as a tooltip.
function formatValue(variable: Variable): string {
  if (variable.isSecret) return '••••••••';

  const value = variable.value;

  if (typeof value === 'string') return value;

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }

  return asText(value);
}

export function VariablesClient({ initialVariables, isLoading = false, workflowNames }: Readonly<VariablesClientProps>) {
  const { t } = useI18n();
  const vc = t.weldconnect.variablesClient;

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.variables },
  ]);

  const deleteVariableMutation = useDeleteVariable();
  // The rows come straight from the query (a delete refetches it), not from a
  // local copy: a copy synced in an effect renders one empty frame, "No
  // variables yet", between the data arriving and the effect running.
  const variables = initialVariables;
  const [pendingDelete, setPendingDelete] = useState<Variable | null>(null);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingVariable, setEditingVariable] = useState<Variable | null>(null);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.weldconnect.variables.columns.name, width: COLUMN_WIDTHS.name },
    { id: 'value', header: t.weldconnect.variables.columns.value, width: COLUMN_WIDTHS.value },
    { id: 'type', header: t.weldconnect.variables.columns.type, width: COLUMN_WIDTHS.type },
    { id: 'scope', header: t.weldconnect.variables.columns.scope, width: COLUMN_WIDTHS.scope },
    { id: 'created', header: t.weldconnect.variables.columns.created, width: COLUMN_WIDTHS.created },
    { id: 'actions', header: '', width: COLUMN_WIDTHS.actions },
  ], [t]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'scope',
      label: t.weldconnect.variables.columns.scope,
      options: [
        { value: 'global', label: t.weldconnect.variables.scopes.global },
        { value: 'workflow', label: t.weldconnect.variables.scopes.workflow },
        { value: 'secret', label: t.weldconnect.variables.counts.secrets },
      ],
      getDisplayValue: (value) => {
        if (value === 'secret') return t.weldconnect.variables.counts.secrets;
        return (t.weldconnect.variables.scopes as Record<string, string>)[value] || value;
      },
    },
  ], [t]);

  const applyFilters = useCallback((items: Variable[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach((filter) => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'scope') {
        const matches = (v: Variable) => {
          if (filter.value === 'secret') return v.isSecret;
          return v.scope === filter.value;
        };
        result = filter.operator === 'is'
          ? result.filter(matches)
          : result.filter((v) => !matches(v));
      }
    });
    return result;
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await deleteVariableMutation.mutateAsync(pendingDelete.id);
      toast.success(t.weldconnect.variables.toasts.deleted);
    } catch {
      toast.error(t.weldconnect.variables.toasts.deleteFailed);
    } finally {
      setPendingDelete(null);
    }
  }, [deleteVariableMutation, pendingDelete, t.weldconnect.variables.toasts.deleted, t.weldconnect.variables.toasts.deleteFailed]);

  const renderRow = useCallback((variable: Variable) => {
    const config = scopeClassConfig[variable.scope] || scopeClassConfig.global;
    const ScopeIcon = config.icon;
    const scopeLabel = (t.weldconnect.variables.scopes as Record<string, string>)[variable.scope] || variable.scope;

    return (
      <div
        key={variable.id}
        className="flex items-center gap-4 py-3 px-4 hover:bg-gray-50 dark:hover:bg-secondary/50 group border-b border-gray-200/70 dark:border-border"
      >
        <div className={cn(COLUMN_WIDTHS.name, 'flex items-center gap-2 min-w-0')}>
          {variable.isSecret && <Lock className="h-4 w-4 text-red-600 shrink-0" />}
          <div className="min-w-0">
            <div className="text-sm font-medium font-mono truncate">{variable.name}</div>
            {variable.description && (
              <div className="text-xs text-muted-foreground truncate">{variable.description}</div>
            )}
          </div>
        </div>

        <div className={cn(COLUMN_WIDTHS.value, 'flex items-center gap-2 min-w-0')}>
          <span
            className="text-sm font-mono truncate"
            title={variable.isSecret ? undefined : formatValue(variable)}
          >
            {formatValue(variable)}
          </span>
        </div>

        <div className={COLUMN_WIDTHS.type}>
          <Badge variant="outline" className="capitalize">
            {variable.type}
          </Badge>
        </div>

        <div className={COLUMN_WIDTHS.scope}>
          <Badge variant="outline" className={cn('text-[11px]', config.className)}>
            <ScopeIcon className="h-3 w-3 mr-1" />
            {scopeLabel}
          </Badge>
          {variable.workflowId && workflowNames?.[variable.workflowId] && (
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {workflowNames[variable.workflowId]}
            </div>
          )}
        </div>

        <div className={COLUMN_WIDTHS.created}>
          <div className="text-sm">{new Date(variable.createdAt).toLocaleDateString()}</div>
          <div className="text-xs text-muted-foreground">
            {new Date(variable.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        <div className={cn(COLUMN_WIDTHS.actions, 'flex justify-end')}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t.weldconnect.variables.actionsLabel}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setEditingVariable(variable)}>
                <Edit className="mr-0.5 h-4 w-4" />
                {t.weldconnect.variables.actions.edit}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setPendingDelete(variable)}>
                <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                {t.weldconnect.variables.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [t, workflowNames]);

  return (
    <>
      <EntityList<Variable>
        items={variables}
        isLoading={isLoading}
        headerColumns={headerColumns}
        filters={filterConfigs}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.weldconnect.variables.searchPlaceholder}
        searchFields={['name', 'description']}
        createButton={{
          label: t.weldconnect.variables.createVariable,
          onClick: () => setShowCreateDialog(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <VariableIcon className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: vc.emptyTitle,
          description: vc.emptyDescription,
          action: {
            label: t.weldconnect.variables.createVariable,
            onClick: () => setShowCreateDialog(true),
          },
        }}
        noResultsState={{
          title: vc.noResultsTitle,
          description: vc.noResultsDescription,
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t.weldconnect.variables.deleteConfirmTitle}
        description={t.weldconnect.variables.deleteConfirm.replace('{name}', pendingDelete?.name ?? '')}
        confirmLabel={t.weldconnect.variables.actions.delete}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />

      <VariableDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        mode="create"
      />

      <VariableDialog
        open={!!editingVariable}
        onOpenChange={(open) => !open && setEditingVariable(null)}
        variable={editingVariable || undefined}
        mode="edit"
      />
    </>
  );
}
