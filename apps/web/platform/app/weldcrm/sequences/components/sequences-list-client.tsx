
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
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
  EllipsisVertical,
  Play,
  Pause,
  Edit,
  Trash2,
  Users,
  Plus,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type ActiveFilter,
  type RowHandlers,
  type GroupConfig,
} from '@/components/entity-list';
import type { SequenceSummary } from '@/lib/api/domains/weldcrm';
import { sequenceKeys } from '@/hooks/queries/use-sequences-queries';

interface SequencesListClientProps {
  initialSequences: SequenceSummary[];
  total: number;
}

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  active: {
    label: 'Active',
    color: 'text-green-600 dark:text-green-400',
    bg: 'bg-green-50 dark:bg-green-950',
  },
  paused: {
    label: 'Paused',
    color: 'text-yellow-600 dark:text-yellow-400',
    bg: 'bg-yellow-50 dark:bg-yellow-950',
  },
  draft: {
    label: 'Draft',
    color: 'text-gray-600 dark:text-muted-foreground',
    bg: 'bg-gray-100 dark:bg-secondary',
  },
};

export function SequencesListClient({ initialSequences, total }: SequencesListClientProps) {
  const t = useTranslations();
  useBreadcrumbs([
    { label: t('crm.sequences.breadcrumbCRM'), href: '/weldcrm' },
    { label: t('crm.sequences.breadcrumbSequences') },
  ]);

  const router = useRouter();
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const [sequences, setSequences] = useState(initialSequences);

  // Keep the local list in sync with the query cache. `sequences` seeds from
  // `initialSequences` for optimistic mutations (delete/activate/pause), but
  // the prop changes whenever the underlying query refetches or rehydrates
  // from the persisted client. Without this resync the list would freeze on
  // its first-mount snapshot — e.g. show empty after a reload restored the
  // cache a tick later. `initialSequences` is a stable cache reference, so
  // this only fires on genuine data changes, never clobbering optimistic edits.
  useEffect(() => {
    setSequences(initialSequences);
  }, [initialSequences]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [groupBy, setGroupBy] = useState<'status' | 'none'>('status');

  const formatDate = (date: string | null) => {
    if (!date) return '—';
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMinutes = Math.floor(diffMs / (1000 * 60));

    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('crm.sequences.deleteConfirm'))) return;
    try {
      const client = await getClient();
      await client.delete<void>(`/workflows/${id}`);
      setSequences(sequences.filter((s) => s.id !== id));
      toast.success(t('crm.sequences.deletedSuccess'));
    } catch {
      toast.error(t('crm.sequences.deleteFailed'));
    }
  };

  const handleActivate = async (id: string) => {
    try {
      const client = await getClient();
      await client.patch(`/workflows/${id}/status`, { status: 'active' });
      setSequences(sequences.map((s) => (s.id === id ? { ...s, status: 'active' } : s)));
      toast.success(t('crm.sequences.activatedSuccess'));
    } catch {
      toast.error(t('crm.sequences.activateFailed'));
    }
  };

  const handlePause = async (id: string) => {
    try {
      const client = await getClient();
      await client.patch(`/workflows/${id}/status`, { status: 'paused' });
      setSequences(sequences.map((s) => (s.id === id ? { ...s, status: 'paused' } : s)));
      toast.success(t('crm.sequences.pausedSuccess'));
    } catch {
      toast.error(t('crm.sequences.pauseFailed'));
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setIsCreating(true);
    try {
      const client = await getClient();
      const result = await client.post<{ data: { id: string } }>('/workflows', {
        name: newName.trim(),
        status: 'draft',
        tags: ['__type:sequence'],
      });
      if (result?.data?.id) {
        setShowCreateDialog(false);
        setNewName('');
        // Mark the list stale so returning to it (via back-nav or a fresh
        // load) refetches and includes the just-created sequence — otherwise
        // the 5-minute staleTime keeps the old list cached and the new
        // sequence appears to vanish.
        queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
        router.push(`/weldcrm/sequences/${result.data.id}`);
      } else {
        toast.error(t('crm.sequences.createFailed'));
      }
    } catch {
      toast.error(t('crm.sequences.createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const filterConfigs: FilterConfig[] = useMemo(
    () => [
      {
        field: 'status',
        label: t('crm.sequences.colStatus'),
        options: [
          { value: 'active', label: t('crm.sequences.statusActive') },
          { value: 'paused', label: t('crm.sequences.statusPaused') },
          { value: 'draft', label: t('crm.sequences.statusDraft') },
        ],
      },
    ],
    [t]
  );

  const applyFilters = useCallback(
    (items: SequenceSummary[], filters: ActiveFilter[]) => {
      let result = items;
      filters.forEach((filter) => {
        if (!filter.operator || !filter.value) return;
        if (filter.field === 'status') {
          result =
            filter.operator === 'is'
              ? result.filter((s) => s.status === filter.value)
              : result.filter((s) => s.status !== filter.value);
        }
      });
      return result;
    },
    []
  );

  const groupConfigs = useMemo<GroupConfig<SequenceSummary>[] | undefined>(() => {
    if (groupBy === 'none') return undefined;
    if (groupBy === 'status') {
      return [
        { id: 'active', label: t('crm.sequences.statusActive'), filter: (s) => s.status === 'active', sortOrder: 0 },
        { id: 'paused', label: t('crm.sequences.statusPaused'), filter: (s) => s.status === 'paused', sortOrder: 1 },
        { id: 'draft', label: t('crm.sequences.statusDraft'), filter: (s) => s.status === 'draft', sortOrder: 2 },
      ];
    }
    return undefined;
  }, [groupBy, t]);

  const groupByOptions = [
    { value: 'status' as const, label: t('crm.sequences.groupByStatus') },
    { value: 'none' as const, label: t('crm.sequences.groupByNone') },
  ];
  const groupByLabel = groupByOptions.find((o) => o.value === groupBy)?.label ?? 'Status';

  const groupByMenu = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-sm px-3 shadow-none text-muted-foreground"
        >
          {groupByLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-1">
        {groupByOptions.map((opt) => (
          <Button
            key={opt.value}
            variant="ghost"
            type="button"
            onClick={() => setGroupBy(opt.value)}
            className={cn(
              'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted',
              groupBy === opt.value && 'bg-muted'
            )}
          >
            <span>{opt.label}</span>
            {groupBy === opt.value && <Check className="h-3.5 w-3.5" />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );

  const headerColumns: HeaderColumn[] = useMemo(
    () => [
      { id: 'name', header: t('crm.sequences.colSequence'), width: 'flex-1 min-w-[250px]' },
      { id: 'status', header: t('crm.sequences.colStatus'), width: 'w-[110px]' },
      { id: 'enrolled', header: t('crm.sequences.colEnrolled'), width: 'w-[100px]' },
      { id: 'lastRun', header: t('crm.sequences.colLastRun'), width: 'w-[100px]' },
    ],
    [t]
  );

  const renderRow = useCallback(
    (sequence: SequenceSummary, handlers: RowHandlers<SequenceSummary>) => (
      <div
        key={sequence.id}
        onClick={() => router.push(`/weldcrm/sequences/${sequence.id}`)}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Name */}
        <div className="flex-1 min-w-[250px] min-w-0">
          <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
            {sequence.name}
          </span>
          {sequence.description && (
            <p className="text-xs text-gray-500 truncate">{sequence.description}</p>
          )}
        </div>

        {/* Status */}
        <div className="w-[110px] flex items-center">
          <span
            className={cn(
              'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
              statusConfig[sequence.status]?.color,
              statusConfig[sequence.status]?.bg
            )}
          >
            {sequence.status === 'active' ? t('crm.sequences.statusActive') : sequence.status === 'paused' ? t('crm.sequences.statusPaused') : sequence.status === 'draft' ? t('crm.sequences.statusDraft') : sequence.status}
          </span>
        </div>

        {/* Enrolled */}
        <div className="w-[100px] flex items-center gap-1.5">
          <span className="text-sm font-mono font-medium text-gray-600 dark:text-muted-foreground">
            {sequence.enrolledCount || 0}
          </span>
          {sequence.activeEnrolledCount > 0 && (
            <span className="text-xs font-mono text-green-600 dark:text-green-400">
              ({sequence.activeEnrolledCount} active)
            </span>
          )}
        </div>

        {/* Last Run */}
        <div className="w-[100px]">
          <span className="text-sm font-mono text-gray-500">{formatDate(sequence.lastExecutedAt)}</span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push(`/weldcrm/sequences/${sequence.id}/people`)}>
                <Users className="h-4 w-4 mr-2" />
                {t('crm.sequences.menuViewPeople')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/weldcrm/sequences/${sequence.id}`)}>
                <Edit className="h-4 w-4 mr-2" />
                {t('crm.sequences.menuEditSteps')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {sequence.status !== 'active' && (
                <DropdownMenuItem onClick={() => handleActivate(sequence.id)}>
                  <Play className="h-4 w-4 mr-2" />
                  {t('crm.sequences.menuActivate')}
                </DropdownMenuItem>
              )}
              {sequence.status === 'active' && (
                <DropdownMenuItem onClick={() => handlePause(sequence.id)}>
                  <Pause className="h-4 w-4 mr-2" />
                  {t('crm.sequences.menuPause')}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600"
                onClick={() => handleDelete(sequence.id)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t('crm.sequences.menuDelete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    ),
    [router]
  );

  return (
    <>
      <EntityList
        items={sequences}
        isLoading={false}
        headerColumns={headerColumns}
        filters={filterConfigs}
        applyFilters={applyFilters}
        groups={groupConfigs}
        leftActionButtons={groupByMenu}
        searchPlaceholder={t('crm.sequences.searchPlaceholder')}
        searchFields={['name' as keyof SequenceSummary]}
        renderRow={renderRow}
        createButton={{
          label: t('crm.sequences.newSequence'),
          onClick: () => setShowCreateDialog(true),
        }}
        emptyState={{
          icon: <EmptyStateIllustration />,
          title: t('crm.sequences.noSequencesYet'),
          description: t('crm.sequences.noSequencesDescription'),
          action: {
            label: t('crm.sequences.newSequence'),
            onClick: () => setShowCreateDialog(true),
          },
        }}
        noResultsState={{
          title: t('crm.sequences.noMatchingSequences'),
          description: t('crm.sequences.noMatchingDescription'),
        }}
      />

      {/* Create Sequence Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('crm.sequences.createDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">{t('crm.sequences.createDialog.nameLabel')}</Label>
              <Input
                id="name"
                placeholder={t('crm.sequences.createDialog.namePlaceholder')}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('crm.sequences.createDialog.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || isCreating}>
              {isCreating ? t('crm.sequences.createDialog.creating') : t('crm.sequences.createDialog.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
