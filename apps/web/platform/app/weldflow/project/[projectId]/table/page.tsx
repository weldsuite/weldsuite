import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { Trash2, EllipsisVertical, Copy, Pencil, Table2 } from 'lucide-react';
import { isToday, isYesterday, isThisWeek, isThisMonth, subMonths, isAfter } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter, type RowHandlers } from '@/components/entity-list';
import { useParams, useRouter } from '@/lib/router';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { tablesApi } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { toast } from 'sonner';

interface TableItem {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function ProjectTablePage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { canWrite } = useProjectPermissions();
  const { t } = useI18n();

  const [items, setItems] = useState<TableItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Each workbook has its own dedicated route — `/.../table/[fileId]` —
  // so opening a sheet is just a navigation. This makes refresh, deep links,
  // and back/forward work naturally, and isolates the editor's auto-save
  // lifecycle from the list view.
  const openTable = useCallback(
    (id: string) => {
      router.push(`/weldflow/project/${projectId}/table/${id}`);
    },
    [router, projectId],
  );

  // Create dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  // Rename dialog
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTableId, setRenameTableId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const loadTables = useCallback(async () => {
    setIsLoading(true);
    const result = await tablesApi.listTables(projectId);
    if (result.success && result.data) {
      setItems(result.data);
    }
    setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  const filterConfigs: FilterConfig[] = useMemo(() => [], []);

  const groupConfigs: GroupConfig<TableItem>[] = useMemo(() => {
    const now = new Date();
    const oneMonthAgo = subMonths(now, 1);
    const threeMonthsAgo = subMonths(now, 3);

    return [
      { id: 'today', label: t.projects.table.groupToday, filter: (d) => isToday(new Date(d.updatedAt)), sortOrder: 0 },
      { id: 'yesterday', label: t.projects.table.groupYesterday, filter: (d) => isYesterday(new Date(d.updatedAt)), sortOrder: 1 },
      {
        id: 'this-week', label: t.projects.table.groupThisWeek, sortOrder: 2,
        filter: (d) => { const date = new Date(d.updatedAt); return isThisWeek(date, { weekStartsOn: 1 }) && !isToday(date) && !isYesterday(date); },
      },
      {
        id: 'this-month', label: t.projects.table.groupThisMonth, sortOrder: 3,
        filter: (d) => { const date = new Date(d.updatedAt); return isThisMonth(date) && !isThisWeek(date, { weekStartsOn: 1 }); },
      },
      {
        id: 'last-month', label: t.projects.table.groupLastMonth, sortOrder: 4,
        filter: (d) => { const date = new Date(d.updatedAt); return !isThisMonth(date) && isAfter(date, oneMonthAgo); },
      },
      {
        id: 'last-3-months', label: t.projects.table.groupLast3Months, sortOrder: 5,
        filter: (d) => { const date = new Date(d.updatedAt); return !isAfter(date, oneMonthAgo) && isAfter(date, threeMonthsAgo); },
      },
      { id: 'older', label: t.projects.table.groupOlder, filter: (d) => !isAfter(new Date(d.updatedAt), threeMonthsAgo), sortOrder: 6 },
    ];
  }, [t]);

  const applyFilters = useCallback((items: TableItem[], _filters: ActiveFilter[]) => {
    return items;
  }, []);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.projects.table.headerName, width: 'flex-1 min-w-[300px]' },
    { id: 'updated', header: t.projects.table.headerLastUpdated, width: 'w-[140px]' },
    { id: 'created', header: t.projects.table.headerCreated, width: 'w-[140px]' },
  ], [t]);

  const handleDeleteTable = useCallback(async (tableId: string) => {
    const result = await tablesApi.deleteTable(projectId, tableId);
    if (result.success) {
      setItems(prev => prev.filter(t => t.id !== tableId));
      toast.success(t.projects.table.tableDeleted);
    } else {
      toast.error(t.projects.table.failedToDeleteTable);
    }
  }, [projectId]);

  const openRenameDialog = useCallback((item: TableItem) => {
    setRenameTableId(item.id);
    setRenameValue(item.name);
    setRenameDialogOpen(true);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }, []);

  const handleRenameTable = useCallback(async () => {
    if (!renameTableId || !renameValue.trim()) return;
    setIsRenaming(true);
    const result = await tablesApi.updateTable(projectId, renameTableId, { name: renameValue.trim() });
    setIsRenaming(false);
    if (result.success) {
      setItems(prev => prev.map(t => t.id === renameTableId ? { ...t, name: renameValue.trim() } : t));
      setRenameDialogOpen(false);
      toast.success(t.projects.table.tableRenamed);
    } else {
      toast.error(t.projects.table.failedToRenameTable);
    }
  }, [projectId, renameTableId, renameValue]);

  const renderRow = useCallback((item: TableItem, _handlers: RowHandlers<TableItem>) => {
    return (
      <div
        key={item.id}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        onClick={() => openTable(item.id)}
      >
        <div className="flex-1 min-w-[300px] flex items-center gap-2">
          <Table2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
            {item.name || t.projects.table.untitled}
          </p>
        </div>

        <div className="w-[140px]">
          <span className="text-sm text-gray-500">{formatDate(item.updatedAt)}</span>
        </div>

        <div className="w-[140px]">
          <span className="text-sm text-gray-500">{formatDate(item.createdAt)}</span>
        </div>

        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 text-gray-400 hover:text-gray-600"
              >
                <EllipsisVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openRenameDialog(item)}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.projects.table.renameTable}
              </DropdownMenuItem>
              {canWrite && (
                <DropdownMenuItem
                  onClick={() => handleDeleteTable(item.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                  {t.projects.table.deleteTable}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [canWrite, handleDeleteTable, openRenameDialog, t]);

  const openCreateDialog = () => {
    setNewTableName('');
    setCreateDialogOpen(true);
    setTimeout(() => createInputRef.current?.focus(), 0);
  };

  const handleCreateTable = async () => {
    const name = newTableName.trim() || t.projects.table.untitled;
    setIsCreating(true);
    const result = await tablesApi.createTable(projectId, { name });
    setIsCreating(false);
    if (result.success && result.data) {
      setCreateDialogOpen(false);
      openTable(result.data.id);
    } else {
      toast.error(t.projects.table.failedToCreateTable);
    }
  };

  // List view
  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <>
      <EntityList<TableItem>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={t.projects.table.searchPlaceholder}
        searchFields={['name']}
        topBarClassName="pt-2 pb-2"
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
        createButton={canWrite ? {
          label: t.projects.table.newTableBtn,
          onClick: openCreateDialog,
        } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration width={260} height={170}>
              <svg width="150" height="120" viewBox="0 0 150 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginLeft: 3 }}>
                <rect x="10" y="14" width="130" height="92" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="10" y="14" width="130" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                {/* Row dividers */}
                <line x1="10" y1="34" x2="140" y2="34" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="1" />
                <line x1="10" y1="52" x2="140" y2="52" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="1" opacity="0.6" />
                <line x1="10" y1="70" x2="140" y2="70" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="1" opacity="0.5" />
                <line x1="10" y1="88" x2="140" y2="88" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="1" opacity="0.4" />
                {/* Column dividers */}
                <line x1="55" y1="14" x2="55" y2="106" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="1" opacity="0.5" />
                <line x1="100" y1="14" x2="100" y2="106" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="1" opacity="0.3" />
                {/* Header cells */}
                <rect x="18" y="20" width="28" height="8" rx="2" className="fill-gray-200 dark:fill-white/10" opacity="0.8" />
                <rect x="63" y="20" width="22" height="8" rx="2" className="fill-gray-200 dark:fill-white/10" opacity="0.6" />
                <rect x="108" y="20" width="18" height="8" rx="2" className="fill-gray-200 dark:fill-white/10" opacity="0.4" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t.projects.table.noTablesTitle,
          description: t.projects.table.noTablesDesc,
          action: canWrite ? {
            label: t.projects.table.newTableBtn,
            onClick: openCreateDialog,
          } : undefined,
        }}
        noResultsState={{
          title: t.projects.table.noTablesTitle,
          description: t.projects.table.noResultsDesc,
        }}
      />

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.table.createDialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="table-name">{t.projects.table.nameLabel}</Label>
              <Input
                id="table-name"
                ref={createInputRef}
                placeholder={t.projects.table.namePlaceholder}
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateTable();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {t.projects.table.cancelBtn}
            </Button>
            <Button onClick={handleCreateTable} disabled={isCreating}>
              {isCreating ? t.projects.table.creatingBtn : t.projects.table.createBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.table.renameDialogTitle}</DialogTitle>
            <DialogDescription>
              {t.projects.table.renameDialogDesc}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="rename-table">{t.projects.table.nameLabel}</Label>
              <Input
                id="rename-table"
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRenaming) {
                    handleRenameTable();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t.projects.table.cancelBtn}
            </Button>
            <Button onClick={handleRenameTable} disabled={isRenaming}>
              {isRenaming ? t.projects.table.savingBtn : t.projects.table.saveBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
