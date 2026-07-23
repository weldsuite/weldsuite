import { useCallback, useMemo, useState } from 'react';
import { Check, Hash, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useNavigate } from '@tanstack/react-router';
import {
  useChatDrafts,
  useDeleteDraft,
} from '@/hooks/queries/use-weldchat-extras-queries';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import type { DraftItem } from '@weldsuite/core-api-client/schemas/weldchat-drafts';
import {
  EmptyStateIllustration,
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type GroupConfig,
  type HeaderColumn,
  type RowHandlers,
} from '@/components/entity-list';

type DraftCategory = 'channel' | 'thread' | 'dm' | 'other';

function categorize(draft: DraftItem): DraftCategory {
  if (draft.threadParentMessageId) return 'thread';
  if (draft.channelName) return 'channel';
  if (draft.channelId) return 'dm';
  return 'other';
}

function draftLabel(draft: DraftItem, labels: { threadReply: string; directMessage: string; draft: string }): string {
  if (draft.channelName) return `#${draft.channelName}`;
  if (draft.threadParentMessageId) return labels.threadReply;
  if (draft.channelId) return labels.directMessage;
  return labels.draft;
}

function formatRelative(
  dateStr: string | null | undefined,
  st: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  if (diff < 0) return st('sweep.weldchat.relativeTime.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return st('sweep.weldchat.relativeTime.justNow');
  if (mins < 60) return st('sweep.weldchat.relativeTime.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return st('sweep.weldchat.relativeTime.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return st('sweep.weldchat.relativeTime.daysAgo', { count: days });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function DraftsPage() {
  const t = getTranslations('weldchat');
  const st = useTranslations();
  const navigate = useNavigate();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [groupBy, setGroupBy] = useState<'type' | 'none'>('type');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    { label: t.drafts ?? 'Drafts' },
  ]);

  const { data, isLoading } = useChatDrafts();
  const { mutate: deleteDraft, isPending: isDeleting } = useDeleteDraft();

  const drafts: DraftItem[] = useMemo(() => (data as any)?.data ?? [], [data]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'type',
      label: t.activityPage?.typeLabel ?? 'Type',
      options: [
        { value: 'channel', label: t.draftsPage?.channel ?? 'Channel' },
        { value: 'thread', label: t.draftsPage?.thread ?? 'Thread' },
        { value: 'dm', label: t.draftsPage?.directMessageGroup ?? 'Direct message' },
      ],
    },
  ], [t]);

  const applyFilters = useCallback((items: DraftItem[], filters: ActiveFilter[]) => {
    let result = items;
    for (const f of filters) {
      if (!f.value || f.operator !== 'is') continue;
      if (f.field === 'type') {
        result = result.filter(d => categorize(d) === f.value);
      }
    }
    return result;
  }, []);

  const groupConfigs: GroupConfig<DraftItem>[] = useMemo(() => {
    if (groupBy === 'none') return [];
    return [
      { id: 'channel', label: t.draftsPage?.channels ?? 'Channels', filter: (d) => categorize(d) === 'channel', sortOrder: 0 },
      { id: 'thread', label: t.draftsPage?.threads ?? 'Threads', filter: (d) => categorize(d) === 'thread', sortOrder: 1 },
      { id: 'dm', label: t.draftsPage?.directMessages ?? 'Direct messages', filter: (d) => categorize(d) === 'dm', sortOrder: 2 },
      { id: 'other', label: t.draftsPage?.other ?? 'Other', filter: (d) => categorize(d) === 'other', sortOrder: 3 },
    ];
  }, [groupBy, t]);

  const groupByOptions = [
    { value: 'type' as const, label: t.activityPage?.groupByType ?? 'Type' },
    { value: 'none' as const, label: t.activityPage?.groupByNone ?? 'None' },
  ];
  const groupByLabel = groupByOptions.find(o => o.value === groupBy)?.label ?? (t.activityPage?.groupByType ?? 'Type');

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
        {groupByOptions.map(opt => (
          <Button
            key={opt.value}
            variant="ghost"
            type="button"
            onClick={() => setGroupBy(opt.value)}
            className={cn(
              'w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted',
              groupBy === opt.value && 'bg-muted',
            )}
          >
            <span>{opt.label}</span>
            {groupBy === opt.value && <Check className="h-3.5 w-3.5" />}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.draftsPage?.draft ?? 'Draft', width: 'w-[260px] flex-shrink-0' },
    { id: 'preview', header: t.draftsPage2?.previewHeader ?? 'Preview', width: 'flex-1 min-w-0' },
    { id: 'last', header: t.draftsPage2?.updatedHeader ?? 'Updated', width: 'w-[120px] flex-shrink-0' },
  ], [t]);

  function handleContinueWriting(draft: DraftItem) {
    if (draft.channelId) {
      navigate({ to: '/weldchat/$channelId', params: { channelId: draft.channelId } });
    }
  }

  function handleConfirmDelete() {
    if (!deletingId) return;
    deleteDraft(deletingId, {
      onSuccess: () => setDeletingId(null),
    });
  }

  const renderRow = useCallback((draft: DraftItem, _handlers: RowHandlers<DraftItem>) => {
    const category = categorize(draft);
    const Icon = category === 'thread' ? MessageSquare : category === 'dm' ? MessageSquare : Hash;
    return (
      <div
        key={draft.id}
        onClick={() => handleContinueWriting(draft)}
        className={cn(
          'flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border group',
          draft.channelId
            ? 'hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer'
            : '',
        )}
      >
        <div className="w-[260px] flex-shrink-0 flex items-center gap-3 min-w-0">
          <div className="h-6 w-6 flex items-center justify-center flex-shrink-0">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
            {draftLabel(draft, {
              threadReply: t.draftsPage?.threadReply ?? 'Thread reply',
              directMessage: t.draftsPage?.directMessage ?? 'Direct message',
              draft: t.draftsPage?.draft ?? 'Draft',
            })}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          {draft.content ? (
            <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">
              {draft.content}
            </span>
          ) : (
            <span className="text-sm text-gray-400 italic">{t.draftsPage?.noContent ?? 'No content'}</span>
          )}
        </div>

        <div className="w-[120px] flex-shrink-0">
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {formatRelative(draft.updatedAt, st)}
          </span>
        </div>

        <div className="w-[40px] flex-shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
            onClick={() => setDeletingId(draft.id)}
            title={t.draftsPage?.deleteDraft ?? 'Delete draft'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }, [navigate, t, st]);

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EntityList<DraftItem>
          items={drafts}
          isLoading={isLoading}
          error={null}
          headerColumns={headerColumns}
          filters={filterConfigs}
          groups={groupConfigs}
          maxFilters={3}
          applyFilters={applyFilters}
          renderRow={renderRow}
          leftActionButtons={groupByMenu}
          searchPlaceholder={t.draftsPage2?.searchPlaceholder ?? 'Search drafts...'}
          searchFields={['content', 'channelName'] as (keyof DraftItem)[]}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                  <rect x="28" y="22" width="64" height="80" rx="6" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                  <rect x="38" y="38" width="44" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="38" y="48" width="36" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="38" y="58" width="40" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M76 70l16-16 6 6-16 16-8 2 2-8z" className="fill-gray-200 dark:fill-white/15 stroke-gray-300 dark:stroke-white/20" strokeWidth="1" />
                </svg>
              </EmptyStateIllustration>
            ),
            title: t.draftsEmpty ?? 'You have no drafts',
            description: t.draftsEmptyHint ?? "Start typing a message and we'll save it here.",
          }}
          noResultsState={{
            icon: <Pencil className="w-4 h-4 text-gray-400" />,
            title: t.draftsPage2?.noResultsTitle ?? 'No drafts found',
            description: t.draftsPage2?.noResultsDescription ?? "We couldn't find any drafts matching your filter.",
          }}
        />
      </div>

      <AlertDialog open={!!deletingId} onOpenChange={(open) => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.draftsPage?.deleteTitle ?? 'Delete draft?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.draftsPage?.deleteDescription ?? 'This draft will be permanently removed. This action cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t.draftsPage?.cancel ?? 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t.draftsPage?.delete ?? 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
