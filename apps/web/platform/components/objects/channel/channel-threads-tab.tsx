import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { MessageSquare } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  EntityList,
  type ActiveFilter,
  type FilterConfig,
  type RowHandlers,
} from '@/components/entity-list';

interface ChannelThreadsTabProps {
  channelId: string;
  messages: any[];
}

type ThreadItem = {
  id: string;
  channelId: string;
  authorId?: string | null;
  authorName?: string | null;
  authorAvatar?: string | null;
  content?: string | null;
  createdAt?: string | null;
  lastReplyAt?: string | null;
  replyCount: number;
};

export function ChannelThreadsTab({ channelId, messages }: ChannelThreadsTabProps) {
  const st = useTranslations();
  const navigate = useNavigate();

  const threads: ThreadItem[] = useMemo(
    () =>
      messages
        .filter((m) => (m.threadReplyCount ?? 0) > 0)
        .map((m) => ({
          id: m.id,
          channelId,
          authorId: m.authorId,
          authorName: m.authorName,
          authorAvatar: m.authorAvatar,
          content: m.content,
          createdAt: m.createdAt,
          lastReplyAt: m.lastReplyAt,
          replyCount: m.threadReplyCount ?? 0,
        }))
        .sort(
          (a, b) =>
            new Date(b.lastReplyAt ?? b.createdAt ?? 0).getTime() -
            new Date(a.lastReplyAt ?? a.createdAt ?? 0).getTime(),
        ),
    [messages, channelId],
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  // Build a "Started by" filter from the unique authors present in the thread
  // list — same pattern bookmarks-panel uses for its Channel filter.
  const authorFilterConfigs: FilterConfig[] = useMemo(() => {
    const byAuthor = new Map<string, string>();
    for (const t of threads) {
      const key = t.authorId ?? t.authorName;
      const label = t.authorName ?? t.authorId;
      if (key && label && !byAuthor.has(key)) byAuthor.set(key, label);
    }
    if (byAuthor.size === 0) return [];
    return [
      {
        field: 'authorId',
        label: st('sweep.entities.startedBy'),
        options: Array.from(byAuthor.entries()).map(([value, label]) => ({
          value,
          label,
        })),
      },
    ];
  }, [threads, st]);

  const filteredItems = useMemo(() => {
    let items = threads;
    const authorFilter = activeFilters.find(
      (f) => f.field === 'authorId' && f.operator === 'is',
    );
    if (authorFilter && typeof authorFilter.value === 'string') {
      items = items.filter(
        (t) => t.authorId === authorFilter.value || t.authorName === authorFilter.value,
      );
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (t) =>
          t.authorName?.toLowerCase().includes(q) ||
          t.content?.toLowerCase().includes(q),
      );
    }
    return items;
  }, [threads, searchQuery, activeFilters]);

  const renderRow = useCallback(
    (t: ThreadItem, _handlers: RowHandlers<ThreadItem>) => (
      <div
        key={t.id}
        role="button"
        tabIndex={0}
        onClick={() =>
          navigate({
            to: '/weldchat/$channelId/thread/$messageId',
            params: { channelId: t.channelId, messageId: t.id },
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigate({
              to: '/weldchat/$channelId/thread/$messageId',
              params: { channelId: t.channelId, messageId: t.id },
            });
          }
        }}
        className="flex items-start gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border"
      >
        <div className="flex-1 min-w-0 flex items-start gap-3">
          <div className="relative flex-shrink-0 mt-0.5">
            <Avatar className="h-6 w-6 !rounded-[8px]">
              {t.authorAvatar && (
                <AvatarImage src={t.authorAvatar} className="!rounded-[8px]" />
              )}
              <AvatarFallback className="text-[10px] !rounded-[8px]">
                {(t.authorName || '?')[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="absolute -bottom-0.5 -right-0.5 h-[12px] w-[12px] rounded-full bg-background flex items-center justify-center">
              <MessageSquare className="h-2.5 w-2.5 text-foreground" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-sm leading-snug truncate font-semibold text-foreground">
              {t.authorName}
            </div>
            {t.content && (
              <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-0.5 line-clamp-2">
                {t.content}
              </div>
            )}
            <div className="text-[11px] text-primary mt-1">
              {st(
                t.replyCount === 1
                  ? 'sweep.entities.replyCountSingular'
                  : 'sweep.entities.replyCountPlural',
                { count: t.replyCount },
              )}
            </div>
          </div>
        </div>
      </div>
    ),
    [navigate, st],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        {filteredItems.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-muted-foreground pointer-events-none z-10">
            <p className="text-sm font-medium">{st('sweep.entities.noThreadsYet')}</p>
            <p className="text-xs mt-1 text-center">
              {st('sweep.entities.noThreadsYetDescription')}
            </p>
          </div>
        )}
        <EntityList<ThreadItem>
          items={filteredItems}
          isLoading={false}
          error={null}
          filters={authorFilterConfigs}
          maxFilters={2}
          renderRow={renderRow}
          searchPlaceholder={st('sweep.entities.searchThreadsPlaceholder')}
          searchFields={['authorName', 'content'] as (keyof ThreadItem)[]}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          activeFilters={activeFilters}
          onFiltersChange={setActiveFilters}
        />
      </div>
    </div>
  );
}
