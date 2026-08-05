
import { useState, useMemo, useCallback, useEffect } from 'react';
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
  Eye,
  EyeOff,
  Edit,
  Trash2,
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
import { VariableDialog } from './variable-dialog';

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
}

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

function formatValue(variable: Variable, revealed: boolean): string {
  if (variable.isSecret && !revealed) return '••••••••';

  const value = variable.value;

  if (typeof value === 'string') {
    return value.length > 50 ? `${value.substring(0, 50)}...` : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'object') {
    return `${JSON.stringify(value).substring(0, 50)}...`;
  }

  return String(value);
}

export function VariablesClient({ initialVariables, isLoading = false }: VariablesClientProps) {
  const { t } = useI18n();
  const vc = t.weldconnect.variablesClient;

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.variables },
  ]);

  const deleteVariableMutation = useDeleteVariable();
  const [variables, setVariables] = useState<Variable[]>(initialVariables);

  useEffect(() => {
    setVariables(initialVariables);
  }, [initialVariables]);

  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingVariable, setEditingVariable] = useState<Variable | null>(null);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.weldconnect.variables.columns.name, width: 'min-w-[200px] flex-1' },
    { id: 'value', header: t.weldconnect.variables.columns.value, width: 'w-[220px]' },
    { id: 'type', header: t.weldconnect.variables.columns.type, width: 'w-[100px]' },
    { id: 'scope', header: t.weldconnect.variables.columns.scope, width: 'w-[120px]' },
    { id: 'created', header: t.weldconnect.variables.columns.created, width: 'w-[120px]' },
    { id: 'actions', header: '', width: 'w-[48px] flex-shrink-0' },
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

  const toggleSecretVisibility = useCallback((id: string) => {
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback((variable: Variable) => {
    if (!confirm(t.weldconnect.variables.deleteConfirm.replace('{name}', variable.name))) return;

    deleteVariableMutation.mutate(variable.id, {
      onSuccess: () => {
        setVariables((prev) => prev.filter((v) => v.id !== variable.id));
        toast.success(t.weldconnect.variables.toasts.deleted);
      },
      onError: () => {
        toast.error(t.weldconnect.variables.toasts.deleteFailed);
      },
    });
  }, [deleteVariableMutation, t.weldconnect.variables.deleteConfirm, t.weldconnect.variables.toasts.deleted, t.weldconnect.variables.toasts.deleteFailed]);

  const renderRow = useCallback((variable: Variable) => {
    const config = scopeClassConfig[variable.scope] || scopeClassConfig.global;
    const ScopeIcon = config.icon;
    const scopeLabel = (t.weldconnect.variables.scopes as Record<string, string>)[variable.scope] || variable.scope;

    return (
      <div
        key={variable.id}
        className="flex items-center gap-4 py-3 px-4 hover:bg-gray-50 dark:hover:bg-secondary/50 group border-b border-gray-200/70 dark:border-border"
      >
        <div className="min-w-[200px] flex-1 flex items-center gap-2 min-w-0">
          {variable.isSecret && <Lock className="h-4 w-4 text-red-600 shrink-0" />}
          <div className="min-w-0">
            <div className="text-sm font-medium font-mono truncate">{variable.name}</div>
            {variable.description && (
              <div className="text-xs text-muted-foreground truncate">{variable.description}</div>
            )}
          </div>
        </div>

        <div className="w-[220px] flex items-center gap-2 min-w-0">
          <span className="text-sm font-mono truncate">
            {formatValue(variable, revealedSecrets.has(variable.id))}
          </span>
          {variable.isSecret && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                toggleSecretVisibility(variable.id);
              }}
              className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              {revealedSecrets.has(variable.id) ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>

        <div className="w-[100px]">
          <Badge variant="outline" className="capitalize">
            {variable.type}
          </Badge>
        </div>

        <div className="w-[120px]">
          <Badge variant="outline" className={cn('text-[11px]', config.className)}>
            <ScopeIcon className="h-3 w-3 mr-1" />
            {scopeLabel}
          </Badge>
        </div>

        <div className="w-[120px]">
          <div className="text-sm">{new Date(variable.createdAt).toLocaleDateString()}</div>
          <div className="text-xs text-muted-foreground">
            {new Date(variable.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        <div className="w-[48px] flex-shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
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
              <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(variable)}>
                <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                {t.weldconnect.variables.actions.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [handleDelete, revealedSecrets, t, toggleSecretVisibility]);

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
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="28" y="36" width="64" height="48" rx="6" className="fill-white dark:fill-secondary stroke-gray-200 dark:stroke-border" strokeWidth="1" />
                <circle cx="48" cy="56" r="8" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
                <path d="M52 56h20M52 64h14" className="stroke-gray-200 dark:stroke-border" strokeWidth="1.5" strokeLinecap="round" />
                <rect x="40" y="78" width="40" height="4" rx="2" className="fill-gray-200 dark:fill-border" opacity="0.5" />
              </svg>
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
