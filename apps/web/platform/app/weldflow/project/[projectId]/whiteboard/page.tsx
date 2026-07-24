import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Trash2, EllipsisVertical, Copy } from 'lucide-react';
import { isToday, isYesterday, isThisWeek, isThisMonth, subMonths, isAfter } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
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
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { useParams, useRouter } from '@/lib/router';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { whiteboardApi } from '@/app/weldflow/lib/api-client';
import { PageLoader } from '@/components/page-loader';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';

interface WhiteboardItem {
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

export default function WhiteboardPage() {
  const st = useTranslations();
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { canWrite } = useProjectPermissions();

  useBreadcrumbs([
    { label: st('sweep.weldflow.whiteboardListPage.projects'), href: '/weldflow' },
    { label: st('sweep.weldflow.whiteboardListPage.whiteboards') },
  ]);

  const [items, setItems] = useState<WhiteboardItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Create dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newWhiteboardName, setNewWhiteboardName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);

  const loadWhiteboards = useCallback(async () => {
    setIsLoading(true);
    const result = await whiteboardApi.list(projectId);
    if (result.success && result.data) {
      setItems(result.data);
    }
    setIsLoading(false);
  }, [projectId]);

  useEffect(() => {
    loadWhiteboards();
  }, [loadWhiteboards]);

  const filterConfigs: FilterConfig[] = useMemo(() => [], []);

  const groupConfigs: GroupConfig<WhiteboardItem>[] = useMemo(() => {
    const now = new Date();
    const oneMonthAgo = subMonths(now, 1);
    const threeMonthsAgo = subMonths(now, 3);

    return [
      { id: 'today', label: st('sweep.weldflow.whiteboardListPage.today'), filter: (d) => isToday(new Date(d.updatedAt)), sortOrder: 0 },
      { id: 'yesterday', label: st('sweep.weldflow.whiteboardListPage.yesterday'), filter: (d) => isYesterday(new Date(d.updatedAt)), sortOrder: 1 },
      {
        id: 'this-week', label: st('sweep.weldflow.whiteboardListPage.thisWeek'), sortOrder: 2,
        filter: (d) => { const date = new Date(d.updatedAt); return isThisWeek(date, { weekStartsOn: 1 }) && !isToday(date) && !isYesterday(date); },
      },
      {
        id: 'this-month', label: st('sweep.weldflow.whiteboardListPage.thisMonth'), sortOrder: 3,
        filter: (d) => { const date = new Date(d.updatedAt); return isThisMonth(date) && !isThisWeek(date, { weekStartsOn: 1 }); },
      },
      {
        id: 'last-month', label: st('sweep.weldflow.whiteboardListPage.lastMonth'), sortOrder: 4,
        filter: (d) => { const date = new Date(d.updatedAt); return !isThisMonth(date) && isAfter(date, oneMonthAgo); },
      },
      {
        id: 'last-3-months', label: st('sweep.weldflow.whiteboardListPage.last3Months'), sortOrder: 5,
        filter: (d) => { const date = new Date(d.updatedAt); return !isAfter(date, oneMonthAgo) && isAfter(date, threeMonthsAgo); },
      },
      { id: 'older', label: st('sweep.weldflow.whiteboardListPage.older'), filter: (d) => !isAfter(new Date(d.updatedAt), threeMonthsAgo), sortOrder: 6 },
    ];
  }, [st]);

  const applyFilters = useCallback((items: WhiteboardItem[]) => {
    return items;
  }, []);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: st('sweep.weldflow.whiteboardListPage.name'), width: 'flex-1 min-w-[300px]' },
    { id: 'updated', header: st('sweep.weldflow.whiteboardListPage.lastUpdated'), width: 'w-[140px]' },
    { id: 'created', header: st('sweep.weldflow.whiteboardListPage.created'), width: 'w-[140px]' },
  ], [st]);

  const handleDeleteWhiteboard = useCallback(async (wbId: string) => {
    const result = await whiteboardApi.delete(projectId, wbId);
    if (result.success) {
      setItems(prev => prev.filter(w => w.id !== wbId));
      toast.success(st('sweep.weldflow.whiteboardListPage.deletedToast'));
    } else {
      toast.error(st('sweep.weldflow.whiteboardListPage.deleteFailedToast'));
    }
  }, [projectId, st]);

  const handleDuplicateWhiteboard = useCallback(async (wb: WhiteboardItem) => {
    const result = await whiteboardApi.create(projectId, { name: st('sweep.weldflow.whiteboardListPage.copyName', { name: wb.name || st('sweep.weldflow.whiteboardListPage.defaultName') }) });
    if (result.success && result.data) {
      setItems(prev => [result.data!, ...prev]);
      toast.success(st('sweep.weldflow.whiteboardListPage.duplicatedToast'));
    } else {
      toast.error(st('sweep.weldflow.whiteboardListPage.duplicateFailedToast'));
    }
  }, [projectId, st]);

  const renderRow = useCallback((item: WhiteboardItem) => {
    return (
      <div
        key={item.id}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
        onClick={() => router.push(`/weldflow/project/${projectId}/whiteboard/${item.id}`)}
      >
        <div className="flex-1 min-w-[300px]">
          <p className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
            {item.name || st('sweep.weldflow.whiteboardListPage.untitled')}
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
              <DropdownMenuItem onClick={() => handleDuplicateWhiteboard(item)}>
                <Copy className="h-4 w-4 mr-0.5" />
                {st('sweep.weldflow.whiteboardListPage.duplicate')}
              </DropdownMenuItem>
              {canWrite && (
                <DropdownMenuItem
                  onClick={() => handleDeleteWhiteboard(item.id)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                  {st('sweep.weldflow.whiteboardListPage.delete')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [canWrite, handleDeleteWhiteboard, handleDuplicateWhiteboard, projectId, router, st]);

  const openCreateDialog = () => {
    setNewWhiteboardName('');
    setCreateDialogOpen(true);
    setTimeout(() => createInputRef.current?.focus(), 0);
  };

  const handleCreateWhiteboard = async () => {
    const name = newWhiteboardName.trim() || st('sweep.weldflow.whiteboardListPage.untitled');
    setIsCreating(true);
    const result = await whiteboardApi.create(projectId, { name });
    setIsCreating(false);
    if (result.success && result.data) {
      setCreateDialogOpen(false);
      router.push(`/weldflow/project/${projectId}/whiteboard/${result.data.id}`);
    } else {
      toast.error(st('sweep.weldflow.whiteboardListPage.createFailedToast'));
    }
  };

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <>
      <EntityList<WhiteboardItem>
        items={items}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={3}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={st('sweep.weldflow.whiteboardListPage.searchPlaceholder')}
        searchFields={['name']}
        topBarClassName="pt-2 pb-2"
        emptyStateClassName="min-h-[calc(100dvh-350px)]"
        createButton={canWrite ? {
          label: st('sweep.weldflow.whiteboardListPage.newWhiteboard'),
          onClick: openCreateDialog,
        } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="14" y="14" width="92" height="92" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="14" y="14" width="92" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                <rect x="30" y="36" width="28" height="20" rx="3" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.6" />
                <circle cx="80" cy="52" r="12" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" fill="none" opacity="0.5" />
                <line x1="34" y1="78" x2="68" y2="78" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.4" />
                <path d="M72 70 L86 86" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.35" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: st('sweep.weldflow.whiteboardListPage.emptyTitle'),
          description: st('sweep.weldflow.whiteboardListPage.emptyDescription'),
          action: canWrite ? {
            label: st('sweep.weldflow.whiteboardListPage.newWhiteboard'),
            onClick: openCreateDialog,
          } : undefined,
        }}
        noResultsState={{
          title: st('sweep.weldflow.whiteboardListPage.emptyTitle'),
          description: st('sweep.weldflow.whiteboardListPage.noResultsDescription'),
        }}
      />

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{st('sweep.weldflow.whiteboardListPage.newWhiteboard')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 pt-2 pb-4">
            <div className="grid gap-2">
              <Label htmlFor="whiteboard-name">{st('sweep.weldflow.whiteboardListPage.name')}</Label>
              <Input
                id="whiteboard-name"
                ref={createInputRef}
                placeholder={st('sweep.weldflow.whiteboardListPage.untitled')}
                value={newWhiteboardName}
                onChange={(e) => setNewWhiteboardName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) {
                    handleCreateWhiteboard();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              {st('sweep.weldflow.cancel')}
            </Button>
            <Button onClick={handleCreateWhiteboard} disabled={isCreating}>
              {isCreating ? st('sweep.weldflow.whiteboardListPage.creating') : st('sweep.weldflow.whiteboardListPage.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
