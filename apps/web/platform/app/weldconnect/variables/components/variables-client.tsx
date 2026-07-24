
import { useState, useMemo, useEffect } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  EllipsisVertical,
  Key,
  Lock,
  Globe,
  GitBranch,
  Plus,
  Eye,
  EyeOff,
  Edit,
  Trash2,
  Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useDeleteVariable } from '@/hooks/queries/use-automation-queries';
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
}

// Scope badge class configurations (labels resolved inside component)
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

// Format variable value for display
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
    return JSON.stringify(value).substring(0, 50) + '...';
  }

  return String(value);
}

export function VariablesClient({ initialVariables }: VariablesClientProps) {
  const { t } = useI18n();

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.variables },
  ]);

  const columns = useMemo(() => [
    { id: 'name', label: t.weldconnect.variables.columns.name },
    { id: 'value', label: t.weldconnect.variables.columns.value },
    { id: 'type', label: t.weldconnect.variables.columns.type },
    { id: 'scope', label: t.weldconnect.variables.columns.scope },
    { id: 'created', label: t.weldconnect.variables.columns.created },
  ], [t]);

  const deleteVariableMutation = useDeleteVariable();
  const [variables, setVariables] = useState<Variable[]>(initialVariables);

  // Sync when the parent page's query resolves (initialVariables starts as []
  // because the page no longer shows a full-screen loader while data loads).
  useEffect(() => {
    setVariables(initialVariables);
  }, [initialVariables]);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterScope, setFilterScope] = useState<string>('all');
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingVariable, setEditingVariable] = useState<Variable | null>(null);

  // Calculate counts
  const counts = useMemo(
    () => ({
      global: variables.filter((v) => v.scope === 'global').length,
      workflow: variables.filter((v) => v.scope === 'workflow').length,
      secrets: variables.filter((v) => v.isSecret).length,
      total: variables.length,
    }),
    [variables]
  );

  // Filter and sort variables
  const processedVariables = useMemo(() => {
    const filtered = variables.filter((variable) => {
      const matchesSearch =
        searchQuery === '' ||
        variable.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (variable.description?.toLowerCase().includes(searchQuery.toLowerCase()) || false);

      let matchesFilter = true;
      if (filterScope === 'global') matchesFilter = variable.scope === 'global';
      else if (filterScope === 'workflow') matchesFilter = variable.scope === 'workflow';
      else if (filterScope === 'secret') matchesFilter = variable.isSecret;

      return matchesSearch && matchesFilter;
    });

    if (sortConfig) {
      filtered.sort((a, b) => {
        let aVal: string | number;
        let bVal: string | number;

        switch (sortConfig.key) {
          case 'name':
            aVal = a.name;
            bVal = b.name;
            break;
          case 'type':
            aVal = a.type;
            bVal = b.type;
            break;
          case 'scope':
            aVal = a.scope;
            bVal = b.scope;
            break;
          case 'created':
            aVal = new Date(a.createdAt).getTime();
            bVal = new Date(b.createdAt).getTime();
            break;
          default:
            return 0;
        }

        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [variables, searchQuery, filterScope, sortConfig]);

  const handleSort = (key: string) => {
    setSortConfig((current) => {
      if (!current || current.key !== key) {
        return { key, direction: 'asc' };
      }
      if (current.direction === 'asc') {
        return { key, direction: 'desc' };
      }
      return null;
    });
  };

  const handleSelectAll = () => {
    if (selectedRows.length === processedVariables.length) {
      setSelectedRows([]);
    } else {
      setSelectedRows(processedVariables.map((v) => v.id));
    }
  };

  const handleSelectRow = (id: string) => {
    if (selectedRows.includes(id)) {
      setSelectedRows(selectedRows.filter((rowId) => rowId !== id));
    } else {
      setSelectedRows([...selectedRows, id]);
    }
  };

  const toggleSecretVisibility = (id: string) => {
    setRevealedSecrets((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleDelete = (variable: Variable) => {
    if (!confirm(t.weldconnect.variables.deleteConfirm.replace('{name}', variable.name))) return;

    deleteVariableMutation.mutate(variable.id, {
      onSuccess: () => {
        setVariables(variables.filter((v) => v.id !== variable.id));
        toast.success(t.weldconnect.variables.toasts.deleted);
      },
      onError: () => {
        toast.error(t.weldconnect.variables.toasts.deleteFailed);
      },
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 md:p-8 max-w-[1600px] space-y-6 md:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{t.weldconnect.variables.title}</h1>
            <div className="flex flex-wrap items-center gap-3 md:gap-6 mt-2 md:mt-3">
              <div className="flex flex-wrap items-center gap-2 md:gap-4 text-xs md:text-sm">
                <span className="flex items-center gap-1">
                  <Globe className="h-3.5 w-3.5 md:h-4 md:w-4 text-blue-600" />
                  <span className="font-medium">{counts.global}</span> {t.weldconnect.variables.scopes.global}
                </span>
                <span className="text-muted-foreground hidden sm:inline">•</span>
                <span className="flex items-center gap-1">
                  <GitBranch className="h-3.5 w-3.5 md:h-4 md:w-4 text-purple-600" />
                  <span className="font-medium">{counts.workflow}</span> {t.weldconnect.variables.scopes.workflow}
                </span>
                <span className="text-muted-foreground hidden sm:inline">•</span>
                <span className="flex items-center gap-1">
                  <Lock className="h-3.5 w-3.5 md:h-4 md:w-4 text-red-600" />
                  <span className="font-medium">{counts.secrets}</span> {t.weldconnect.variables.counts.secrets}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button className="h-8 text-xs md:text-sm px-3 shadow-none" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4 mr-0.5" />
              <span className="hidden sm:inline">{t.weldconnect.variables.createVariable}</span>
              <span className="sm:hidden">{t.weldconnect.variables.createVariable}</span>
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="space-y-4 md:space-y-6 mt-6 md:mt-8">
          <div className="space-y-4">
            {/* Controls Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0 -mx-4 px-4 sm:mx-0 sm:px-0">
                <Button
                  variant={filterScope === 'all' ? 'default' : 'outline'}
                  onClick={() => setFilterScope('all')}
                  className="h-8 text-xs md:text-sm px-2 md:px-3 shadow-none whitespace-nowrap flex-shrink-0"
                >
                  {t.weldconnect.variables.counts.all} ({counts.total})
                </Button>
                <Button
                  variant={filterScope === 'global' ? 'default' : 'outline'}
                  onClick={() => setFilterScope('global')}
                  className="h-8 text-xs md:text-sm px-2 md:px-3 shadow-none whitespace-nowrap flex-shrink-0"
                >
                  {t.weldconnect.variables.scopes.global} ({counts.global})
                </Button>
                <Button
                  variant={filterScope === 'workflow' ? 'default' : 'outline'}
                  onClick={() => setFilterScope('workflow')}
                  className="h-8 text-xs md:text-sm px-2 md:px-3 shadow-none whitespace-nowrap flex-shrink-0"
                >
                  {t.weldconnect.variables.scopes.workflow} ({counts.workflow})
                </Button>
                <Button
                  variant={filterScope === 'secret' ? 'default' : 'outline'}
                  onClick={() => setFilterScope('secret')}
                  className="h-8 text-xs md:text-sm px-2 md:px-3 shadow-none whitespace-nowrap flex-shrink-0"
                >
                  {t.weldconnect.variables.counts.secrets} ({counts.secrets})
                </Button>

                {(searchQuery || filterScope !== 'all') && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSearchQuery('');
                      setFilterScope('all');
                    }}
                    className="text-xs md:text-sm text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap flex-shrink-0"
                  >
                    {t.weldconnect.variables.clear}
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shadow-none hidden md:flex">
                  <Download className="h-4 w-4" />
                </Button>

                <div className="relative w-full sm:w-auto">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
                  <Input
                    placeholder={t.weldconnect.variables.searchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-8 pl-9 w-full sm:w-[200px] md:w-[250px] text-sm shadow-none"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border/50 overflow-x-auto -mx-4 md:mx-0">
            <Table className="w-full min-w-[700px] md:min-w-[900px]">
              <TableHeader className="sticky top-0 z-5 bg-background">
                <TableRow className="hover:bg-transparent border-b border-border/50">
                  <TableHead className="w-12 h-10 bg-gray-50 dark:bg-background/50 text-xs">
                    <Checkbox
                      checked={selectedRows.length === processedVariables.length && processedVariables.length > 0}
                      onCheckedChange={handleSelectAll}
                    />
                  </TableHead>
                  {columns.map((column) => (
                    <TableHead
                      key={column.id}
                      className="h-10 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      <Button
                        variant="ghost"
                        onClick={() => handleSort(column.id)}
                        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                      >
                        {column.label}
                        {sortConfig?.key === column.id ? (
                          sortConfig.direction === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30" />
                        )}
                      </Button>
                    </TableHead>
                  ))}
                  <TableHead className="w-12 h-10 bg-gray-50 dark:bg-background/50 text-xs"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {processedVariables.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + 2} className="h-24 text-center">
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <Key className="mb-2 h-8 w-8" />
                        <p className="text-lg font-medium">{t.weldconnect.variables.noVariables}</p>
                        <p className="text-sm mt-1">{t.weldconnect.variables.noVariablesDescription}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  processedVariables.map((variable) => {
                    const config = scopeClassConfig[variable.scope] || scopeClassConfig.global;
                    const ScopeIcon = config.icon;
                    const scopeLabel = (t.weldconnect.variables.scopes as Record<string, string>)[variable.scope] || variable.scope;

                    return (
                      <TableRow
                        key={variable.id}
                        className={cn(
                          'border-b border-border/50 hover:bg-muted/30 transition-all duration-150',
                          selectedRows.includes(variable.id) && 'bg-muted/50'
                        )}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()} className="py-3">
                          <Checkbox
                            checked={selectedRows.includes(variable.id)}
                            onCheckedChange={() => handleSelectRow(variable.id)}
                          />
                        </TableCell>
                        {/* Name */}
                        <TableCell className="py-3">
                          <div className="flex items-center gap-2">
                            {variable.isSecret && <Lock className="h-4 w-4 text-red-600" />}
                            <div>
                              <div className="text-sm font-medium font-mono">{variable.name}</div>
                              {variable.description && (
                                <div className="text-xs text-muted-foreground">{variable.description}</div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        {/* Value */}
                        <TableCell className="py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-mono">
                              {formatValue(variable, revealedSecrets.has(variable.id))}
                            </span>
                            {variable.isSecret && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => toggleSecretVisibility(variable.id)}
                                className="h-6 w-6 p-0"
                              >
                                {revealedSecrets.has(variable.id) ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                        {/* Type */}
                        <TableCell className="py-3">
                          <Badge variant="outline" className="capitalize">
                            {variable.type}
                          </Badge>
                        </TableCell>
                        {/* Scope */}
                        <TableCell className="py-3">
                          <Badge variant="outline" className={config.className}>
                            <ScopeIcon className="h-3 w-3 mr-1" />
                            {scopeLabel}
                          </Badge>
                        </TableCell>
                        {/* Created */}
                        <TableCell className="py-3">
                          <div>
                            <div className="text-sm">{new Date(variable.createdAt).toLocaleDateString()}</div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(variable.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </div>
                          </div>
                        </TableCell>
                        {/* Actions */}
                        <TableCell onClick={(e) => e.stopPropagation()} className="py-3">
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
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleDelete(variable)}
                              >
                                <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                                {t.weldconnect.variables.actions.delete}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

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
    </div>
  );
}
