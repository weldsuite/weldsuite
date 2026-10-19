
import { useState, useMemo, useCallback } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import {
  Key,
  Lock,
  Globe,
  GitBranch,
  Edit,
  Trash2,
  Variable as VariableIcon,
} from 'lucide-react';
import { toast } from 'sonner';
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
import {
  ConnectListRow,
  ConnectRowCell,
  ConnectRowMenu,
  DESTRUCTIVE_MENU_ITEM,
  RowDate,
  RowTitle,
  StatusChip,
  type ChipTone,
} from '../../components/connect-list-row';
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
} as const;

const scopeConfig: Record<string, { icon: React.ElementType; tone: ChipTone }> = {
  global: { icon: Globe, tone: 'blue' },
  workflow: { icon: GitBranch, tone: 'purple' },
  execution: { icon: Key, tone: 'gray' },
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
    const config = scopeConfig[variable.scope] || scopeConfig.global;
    const ScopeIcon = config.icon;
    const scopeLabel = (t.weldconnect.variables.scopes as Record<string, string>)[variable.scope] || variable.scope;
    const workflowName = variable.workflowId ? workflowNames?.[variable.workflowId] : undefined;
    const value = formatValue(variable);

    return (
      <ConnectListRow
        key={variable.id}
        label={variable.name}
        onOpen={() => setEditingVariable(variable)}
        menu={
          <ConnectRowMenu label={t.weldconnect.variables.actionsLabel}>
            <DropdownMenuItem onClick={() => setEditingVariable(variable)}>
              <Edit className="mr-2 h-4 w-4" />
              {t.weldconnect.variables.actions.edit}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className={DESTRUCTIVE_MENU_ITEM} onClick={() => setPendingDelete(variable)}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t.weldconnect.variables.actions.delete}
            </DropdownMenuItem>
          </ConnectRowMenu>
        }
      >
        <ConnectRowCell width={COLUMN_WIDTHS.name}>
          {variable.isSecret && <Lock className="h-3.5 w-3.5 flex-shrink-0 text-red-600 dark:text-red-400" />}
          <span title={variable.description || undefined} className="flex min-w-0 items-center">
            <RowTitle>{variable.name}</RowTitle>
          </span>
        </ConnectRowCell>

        <ConnectRowCell width={COLUMN_WIDTHS.value}>
          <span
            title={variable.isSecret ? undefined : value}
            className="block min-w-0 truncate font-mono text-sm text-gray-600 dark:text-muted-foreground"
          >
            {value}
          </span>
        </ConnectRowCell>

        <ConnectRowCell width={COLUMN_WIDTHS.type}>
          <StatusChip tone="gray">
            <span className="capitalize">{variable.type}</span>
          </StatusChip>
        </ConnectRowCell>

        <ConnectRowCell width={COLUMN_WIDTHS.scope}>
          <span title={workflowName} className="min-w-0 max-w-full">
            <StatusChip tone={config.tone}>
              <ScopeIcon className="mr-1 h-3 w-3 flex-shrink-0" />
              <span className="truncate">{workflowName ?? scopeLabel}</span>
            </StatusChip>
          </span>
        </ConnectRowCell>

        <ConnectRowCell width={COLUMN_WIDTHS.created} className="xl:flex">
          <RowDate>{new Date(variable.createdAt).toLocaleDateString()}</RowDate>
        </ConnectRowCell>
      </ConnectListRow>
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
