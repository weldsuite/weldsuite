import { useCallback, useMemo, useState } from 'react';
import { Bookmark, Check, X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
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
import { cn } from '@/lib/utils';
import { useBookmarks, useDeleteBookmark } from '@/hooks/queries/use-weldchat-queries';
import { useChatContext } from './chat-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type GroupConfig,
  type RowHandlers,
} from '@/components/entity-list';

type BookmarkItem = {
  id: string;
  channelId: string;
  messageId: string;
  channelName?: string | null;
  channelType?: string | null;
  messageAuthorName?: string | null;
  messageAuthorAvatar?: string | null;
  messageContent?: string | null;
  messageCreatedAt?: string | null;
};

export function BookmarksPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n();
  const st = useTranslations();
  const { setRightPanel } = useChatContext();
  const { data, isLoading } = useBookmarks();
  const { mutate: deleteBookmark, isPending: isDeleting } = useDeleteBookmark();
  const navigate = useNavigate();
  const bookmarks: BookmarkItem[] = data?.data || [];

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [groupBy, setGroupBy] = useState<'channel' | 'none'>('channel');
  const [removingId, setRemovingId] = useState<string | null>(null);

  const jumpToMessage = (channelId: string, messageId: string) => {
    navigate({ to: '/weldchat/$channelId', params: { channelId } });
    let attempts = 0;
    const tick = () => {
      const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const prevBg = el.style.backgroundColor;
        const prevTransition = el.style.transition;
        el.style.transition = 'background-color 0.3s';
        el.style.backgroundColor = 'rgba(59, 130, 246, 0.15)';
        setTimeout(() => {
          el.style.backgroundColor = prevBg;
          setTimeout(() => {
            el.style.transition = prevTransition;
          }, 400);
        }, 2500);
        return;
      }
      if (attempts++ < 40) setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  };

  const channelFilterConfigs: FilterConfig[] = useMemo(() => {
    const byChannel = new Map<string, string>();
    for (const bk of bookmarks) {
      if (bk.channelId && bk.channelName) byChannel.set(bk.channelId, bk.channelName);
    }
    if (byChannel.size === 0) return [];
    return [
      {
        field: 'channelId',
        label: t.weldchat.bookmarksGroupBy.channel,
        options: Array.from(byChannel.entries()).map(([id, name]) => ({
          value: id,
          label: `#${name}`,
        })),
      },
    ];
  }, [bookmarks]);

  const groupConfigs: GroupConfig<BookmarkItem>[] = useMemo(() => {
    if (groupBy === 'none') return [];
    const channelIds = new Set<string>();
    const orderedChannels: Array<{ id: string; name: string }> = [];
    for (const bk of bookmarks) {
      if (bk.channelId && !channelIds.has(bk.channelId)) {
        channelIds.add(bk.channelId);
        orderedChannels.push({ id: bk.channelId, name: bk.channelName ?? bk.channelId });
      }
    }
    return orderedChannels.map((ch, idx) => ({
      id: ch.id,
      label: `#${ch.name}`,
      filter: (item: BookmarkItem) => item.channelId === ch.id,
      sortOrder: idx,
    }));
  }, [bookmarks, groupBy]);

  const groupByOptions = [
    { value: 'channel' as const, label: t.weldchat.bookmarksGroupBy.channel },
    { value: 'none' as const, label: t.weldchat.bookmarksGroupBy.none },
  ];
  const groupByLabel = groupByOptions.find(o => o.value === groupBy)?.label ?? t.weldchat.bookmarksGroupBy.channel;

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
            type="button"
            variant="ghost"
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

  const filteredItems = useMemo(() => {
    let items = bookmarks;
    const channelFilter = activeFilters.find(f => f.field === 'channelId' && f.operator === 'is');
    if (channelFilter && typeof channelFilter.value === 'string') {
      items = items.filter(bk => bk.channelId === channelFilter.value);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(bk =>
        bk.messageAuthorName?.toLowerCase().includes(q) ||
        bk.messageContent?.toLowerCase().includes(q) ||
        bk.channelName?.toLowerCase().includes(q),
      );
    }
    return items;
  }, [bookmarks, searchQuery, activeFilters]);

  const renderRow = useCallback((bk: BookmarkItem, _handlers: RowHandlers<BookmarkItem>) => (
    <div
      key={bk.id}
      role="button"
      tabIndex={0}
      onClick={() => jumpToMessage(bk.channelId, bk.messageId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          jumpToMessage(bk.channelId, bk.messageId);
        }
      }}
      className={cn(
        'flex items-start gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group/bk relative',
      )}
    >
      <div className="flex-1 min-w-0 flex items-start gap-3">
        <div className="relative flex-shrink-0 mt-0.5">
          <Avatar className="h-6 w-6 !rounded-[8px]">
            {bk.messageAuthorAvatar && (
              <AvatarImage src={bk.messageAuthorAvatar} className="!rounded-[8px]" />
            )}
            <AvatarFallback className="text-[10px] !rounded-[8px]">
              {(bk.messageAuthorName || '?')[0]?.toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="absolute -bottom-0.5 -right-0.5 h-[12px] w-[12px] rounded-full bg-background flex items-center justify-center">
            <Bookmark className="h-2.5 w-2.5 text-foreground" />
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm leading-snug truncate font-semibold text-foreground">
            {bk.messageAuthorName}
            {bk.channelName && (
              <span className="font-normal text-muted-foreground"> {st('sweep.weldchat.bookmarksPanel.inChannel')} #{bk.channelName}</span>
            )}
          </div>
          {bk.messageContent && (
            <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-0.5">
              {bk.messageContent}
            </div>
          )}
        </div>
      </div>

      <div className="w-[32px] flex-shrink-0 flex justify-end -mr-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-red-500 opacity-0 group-hover/bk:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            setRemovingId(bk.id);
          }}
          title={t.weldchat.bookmarks.remove}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  ), [navigate, t, st]);

  return (
    <>
    <div className="flex flex-col h-full">
      {!embedded && (
        <div className="flex items-center justify-between px-4 border-b h-[53px] flex-shrink-0">
          <div className="flex items-center gap-2">
            <Bookmark className="h-4 w-4" />
            <h3 className="font-semibold text-sm">{t.weldchat.bookmarks.savedItems}</h3>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRightPanel(null)}
            title={t.weldchat.channelHeader.bookmarks}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {filteredItems.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-muted-foreground pointer-events-none z-10">
            <p className="text-sm font-medium">{t.weldchat.bookmarks.empty}</p>
            <p className="text-xs mt-1 text-center">{t.weldchat.bookmarks.emptyHint}</p>
          </div>
        )}
        <EntityList<BookmarkItem>
          items={filteredItems}
          isLoading={isLoading}
          error={null}
          filters={channelFilterConfigs}
          groups={groupConfigs}
          maxFilters={2}
          renderRow={renderRow}
          leftActionButtons={groupByMenu}
          searchPlaceholder={t.weldchat.bookmarks.savedItems}
          searchFields={['messageAuthorName', 'messageContent', 'channelName'] as (keyof BookmarkItem)[]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
        />
      </div>
    </div>
    <AlertDialog
      open={!!removingId}
      onOpenChange={(open) => { if (!open) setRemovingId(null); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.weldchat.bookmarks.removeConfirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {t.weldchat.bookmarks.removeConfirmDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t.weldchat.bookmarks.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (!removingId) return;
              deleteBookmark(removingId, {
                onSuccess: () => setRemovingId(null),
              });
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
