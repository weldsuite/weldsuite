import { useCallback, useMemo, useState } from 'react';
import { Bookmark, Check, Hash, MessageSquare, Trash2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useUser } from '@clerk/clerk-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
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
import {
  useBookmarks,
  useDeleteBookmark,
  useDmChannels,
  useWorkspaceMembers,
  type ChatBookmark,
} from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { messagePreviewText } from '../lib/render-message-content';
import {
  EmptyStateIllustration,
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type GroupConfig,
  type HeaderColumn,
} from '@/components/entity-list';

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

const isDirectMessage = (bk: ChatBookmark) => bk.channelType === 'dm' || bk.channelType === 'group';

/**
 * A channel is `#name`; a DM goes by the people in it, without a `#`. A DM's
 * stored name is fixed at creation (the other members as its creator saw
 * them), so DMs are labelled from `dmLabels` (current members), never from it.
 */
function conversationLabel(bk: ChatBookmark, dmLabels: Map<string, string>, directMessage: string): string {
  if (isDirectMessage(bk)) return dmLabels.get(bk.channelId) || directMessage;
  return bk.channelName ? `#${bk.channelName}` : directMessage;
}

export default function BookmarksPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const navigate = useNavigate();
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [groupBy, setGroupBy] = useState<'channel' | 'none'>('none');
  const [removingId, setRemovingId] = useState<string | null>(null);

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    { label: t.weldchat.bookmarks.savedItems },
  ]);

  const { data, isLoading } = useBookmarks();
  const { mutate: deleteBookmark, isPending: isDeleting } = useDeleteBookmark();
  const { data: membersData } = useWorkspaceMembers();
  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [membersData]);

  const bookmarks: ChatBookmark[] = useMemo(() => data?.data ?? [], [data]);
  const page = t.weldchat.bookmarksPage;

  // DM labels from each DM's current other members, like the sidebar rows.
  const { user } = useUser();
  const { data: dmsData } = useDmChannels();
  const dmLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const dm of dmsData?.data ?? []) {
      const others = (dm.otherMembers ?? []).filter((m) => m?.userId);
      const label = others.length > 0
        ? others.map((m) => m.name || m.email).filter(Boolean).join(', ')
        : user?.fullName
          ? st('sweep.weldchat.sidebar.selfDmLabel', { name: user.fullName })
          : st('sweep.weldchat.sidebar.selfDmFallback');
      if (label) map.set(dm.id, label);
    }
    return map;
  }, [dmsData, user?.fullName, st]);

  // Conversations in first-saved order, for the filter and the groups.
  const conversations = useMemo(() => {
    const seen = new Map<string, string>();
    for (const bk of bookmarks) {
      if (bk.channelId && !seen.has(bk.channelId)) seen.set(bk.channelId, conversationLabel(bk, dmLabels, page.directMessage));
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [bookmarks, dmLabels, page.directMessage]);

  const filterConfigs: FilterConfig[] = useMemo(() => (
    conversations.length === 0 ? [] : [{
      field: 'channelId',
      label: page.conversationHeader,
      options: conversations.map((c) => ({ value: c.id, label: c.label })),
    }]
  ), [conversations, page.conversationHeader]);

  const applyFilters = useCallback((items: ChatBookmark[], filters: ActiveFilter[]) => {
    let result = items;
    for (const f of filters) {
      if (!f.value || f.operator !== 'is') continue;
      if (f.field === 'channelId') result = result.filter((bk) => bk.channelId === f.value);
    }
    return result;
  }, []);

  const groupConfigs: GroupConfig<ChatBookmark>[] = useMemo(() => {
    if (groupBy === 'none') return [];
    return conversations.map((c, idx) => ({
      id: c.id,
      label: c.label,
      filter: (bk: ChatBookmark) => bk.channelId === c.id,
      sortOrder: idx,
    }));
  }, [groupBy, conversations]);

  const groupByOptions = [
    { value: 'channel' as const, label: t.weldchat.bookmarksGroupBy.channel },
    { value: 'none' as const, label: t.weldchat.bookmarksGroupBy.none },
  ];
  const groupByLabel = groupByOptions.find((o) => o.value === groupBy)?.label ?? t.weldchat.bookmarksGroupBy.none;

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
    { id: 'from', header: page.fromHeader, width: 'w-[220px] flex-shrink-0' },
    { id: 'message', header: page.messageHeader, width: 'flex-1 min-w-0' },
    { id: 'conversation', header: page.conversationHeader, width: 'w-[200px] flex-shrink-0' },
    { id: 'sent', header: page.sentHeader, width: 'w-[120px] flex-shrink-0' },
  ], [page]);

  // The channel route opens the message (`msg`) and hands DMs to the DM page.
  const openMessage = useCallback((bk: ChatBookmark) => {
    navigate({ to: '/weldchat/$channelId', params: { channelId: bk.channelId }, search: { msg: bk.messageId } });
  }, [navigate]);

  const renderRow = useCallback((bk: ChatBookmark) => {
    const ConversationIcon = isDirectMessage(bk) ? MessageSquare : Hash;
    const preview = bk.messageContent ? messagePreviewText(bk.messageContent, memberNames) : '';
    const authorName = bk.messageAuthorName || '?';
    return (
      <div
        key={bk.id}
        className="flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border group hover:bg-gray-50 dark:hover:bg-secondary/50"
      >
        <button
          type="button"
          onClick={() => openMessage(bk)}
          className="flex flex-1 min-w-0 items-center gap-4 text-left cursor-pointer"
        >
          <span className="w-[220px] flex-shrink-0 flex items-center gap-3 min-w-0">
            <Avatar className="h-6 w-6 flex-shrink-0 !rounded-[8px]">
              {bk.messageAuthorAvatar && <AvatarImage src={bk.messageAuthorAvatar} className="!rounded-[8px]" />}
              <AvatarFallback className="text-[10px] !rounded-[8px]">{authorName[0].toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">{authorName}</span>
          </span>

          <span className="flex-1 min-w-0">
            {preview ? (
              <span className="text-sm text-gray-600 dark:text-muted-foreground truncate block">{preview}</span>
            ) : (
              <span className="text-sm text-gray-400 italic">{page.noContent}</span>
            )}
          </span>

          <span className="w-[200px] flex-shrink-0 flex items-center gap-1.5 min-w-0 text-sm text-gray-600 dark:text-muted-foreground">
            <ConversationIcon className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{conversationLabel(bk, dmLabels, page.directMessage)}</span>
          </span>

          <span className="w-[120px] flex-shrink-0 text-sm text-gray-600 dark:text-muted-foreground">
            {formatRelative(bk.messageCreatedAt, st)}
          </span>
        </button>

        <div className="w-[40px] flex-shrink-0 flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
            onClick={() => setRemovingId(bk.id)}
            title={t.weldchat.bookmarks.removeBookmark}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }, [openMessage, memberNames, dmLabels, page, st, t]);

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <EntityList<ChatBookmark>
          items={bookmarks}
          isLoading={isLoading}
          error={null}
          headerColumns={headerColumns}
          filters={filterConfigs}
          groups={groupConfigs}
          maxFilters={2}
          applyFilters={applyFilters}
          renderRow={renderRow}
          leftActionButtons={groupByMenu}
          searchPlaceholder={page.searchPlaceholder}
          searchFields={['messageAuthorName', 'messageContent', 'channelName'] as (keyof ChatBookmark)[]}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                  <path d="M38 22h44a6 6 0 0 1 6 6v72l-28-16-28 16V28a6 6 0 0 1 6-6z" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" strokeLinejoin="round" />
                  <rect x="44" y="38" width="32" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="44" y="48" width="24" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                  <rect x="44" y="58" width="28" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
                </svg>
              </EmptyStateIllustration>
            ),
            title: t.weldchat.bookmarks.noSavedItems,
            description: t.weldchat.bookmarks.noSavedItemsHint,
          }}
          noResultsState={{
            icon: <Bookmark className="w-4 h-4 text-gray-400" />,
            title: page.noResultsTitle,
            description: page.noResultsDescription,
          }}
        />
      </div>

      <AlertDialog open={!!removingId} onOpenChange={(open) => { if (!open) setRemovingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.weldchat.bookmarks.removeConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.weldchat.bookmarks.removeConfirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t.weldchat.bookmarks.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!removingId) return;
                deleteBookmark(removingId, { onSuccess: () => setRemovingId(null) });
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t.weldchat.bookmarks.remove}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
