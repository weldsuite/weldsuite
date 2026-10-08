import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Search, Calendar as CalendarIcon, Paperclip, Pin, X, Hash, Lock, MessageSquare } from 'lucide-react';
import { Link } from '@/lib/router';
import { useChannels, useWorkspaceMembers, weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { messagePreviewText } from '../lib/render-message-content';

interface SearchFilters {
  authorId?: string;
  channelId?: string;
  hasFile?: boolean;
  isPinned?: boolean;
  before?: string;
  after?: string;
}

/** A `/chat-search` hit: the message plus the channel it lives in. */
interface SearchResult extends ChatMessage {
  channelId: string;
  hasAttachments?: boolean;
  isPinned?: boolean;
  channel?: { name?: string | null; type?: string | null } | null;
}

const CHIP_DATE_FORMAT = 'MMM d, yyyy';

/** Local start of the picked day as an ISO instant (the API takes ISO datetimes). */
function startOfDayIso(date: Date): string {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export default function SearchPage() {
  const { t } = useI18n();
  const st = useTranslations();
  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    { label: t.weldchat.searchPage.breadcrumb },
  ]);

  const { getClient } = useAppApiClient();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  const [dateOpen, setDateOpen] = useState(false);
  const { data: channelsData } = useChannels();
  const { data: membersData } = useWorkspaceMembers();

  const trimmedQuery = query.trim();
  const searchEnabled = trimmedQuery.length >= 2;

  const { data, isLoading } = useQuery({
    queryKey: [...weldchatKeys.search(trimmedQuery), filters],
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ q: trimmedQuery });
      if (filters.authorId) params.set('authorId', filters.authorId);
      if (filters.channelId) params.set('channelId', filters.channelId);
      if (filters.hasFile) params.set('hasFile', 'true');
      if (filters.isPinned) params.set('isPinned', 'true');
      if (filters.before) params.set('before', filters.before);
      if (filters.after) params.set('after', filters.after);
      return client.get<{ data: { messages: SearchResult[]; total: number } }>(
        `/chat-search?${params.toString()}`,
      );
    },
    enabled: searchEnabled,
  });

  // The search route (both legacy and app-api) answers with
  // `{ data: { messages, total } }` — reading `data.data` handed the render an
  // object and blew up on `.map`. Unwrap `messages` properly. The route has no
  // has-file / pinned filters of its own, so those two apply to the hits here.
  const messages = useMemo(
    () =>
      (data?.data?.messages ?? []).filter(
        (msg) => (!filters.hasFile || msg.hasAttachments) && (!filters.isPinned || msg.isPinned),
      ),
    [data, filters.hasFile, filters.isPinned],
  );

  const channelNameById = useMemo(
    () => new Map((channelsData?.data ?? []).map((ch) => [ch.id, ch.name ?? ''])),
    [channelsData],
  );
  const memberNameByUserId = useMemo(
    () =>
      new Map(
        ((membersData?.data ?? []) as Array<{ userId?: string; name?: string; email?: string }>)
          .filter((m) => m.userId)
          .map((m) => [m.userId as string, m.name || m.email || '']),
      ),
    [membersData],
  );

  const filterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string }> = [];
    if (filters.authorId) {
      const name = memberNameByUserId.get(filters.authorId) || filters.authorId;
      chips.push({ key: 'authorId', label: st('sweep.weldchat.searchPage.filterFrom', { value: name }) });
    }
    if (filters.channelId) {
      const name = channelNameById.get(filters.channelId) || filters.channelId;
      chips.push({ key: 'channelId', label: st('sweep.weldchat.searchPage.filterIn', { value: name }) });
    }
    if (filters.hasFile) chips.push({ key: 'hasFile', label: st('sweep.weldchat.searchPage.filterHasFile') });
    if (filters.isPinned) chips.push({ key: 'isPinned', label: st('sweep.weldchat.searchPage.filterPinned') });
    if (filters.after) {
      const value = format(new Date(filters.after), CHIP_DATE_FORMAT);
      chips.push({ key: 'after', label: st('sweep.weldchat.searchPage.filterAfter', { value }) });
    }
    if (filters.before) {
      const value = format(new Date(filters.before), CHIP_DATE_FORMAT);
      chips.push({ key: 'before', label: st('sweep.weldchat.searchPage.filterBefore', { value }) });
    }
    return chips;
  }, [filters, st, channelNameById, memberNameByUserId]);

  const removeFilter = (key: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      delete next[key as keyof SearchFilters];
      return next;
    });
  };

  const channelLabel = (msg: SearchResult): { label: string; Icon: typeof Hash } => {
    const type = msg.channel?.type;
    if (type === 'dm') return { label: st('sweep.weldchat.sidebar.directMessageFallback'), Icon: MessageSquare };
    if (type === 'group') return { label: st('sweep.weldchat.channelEmptyState.groupFallback'), Icon: MessageSquare };
    const name = msg.channel?.name || channelNameById.get(msg.channelId) || '';
    return { label: name, Icon: type === 'private' ? Lock : Hash };
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="p-4 border-b space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t.weldchat.search.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
            autoFocus
          />
        </div>

        {/* Filter buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant={filters.hasFile ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setFilters((f) => ({ ...f, hasFile: !f.hasFile }))}
          >
            <Paperclip className="h-3 w-3 mr-1" />
            {t.weldchat.search.hasFile}
          </Button>
          <Button
            variant={filters.isPinned ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setFilters((f) => ({ ...f, isPinned: !f.isPinned }))}
          >
            <Pin className="h-3 w-3 mr-1" />
            {t.weldchat.search.pinned}
          </Button>
          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button variant={filters.after ? 'secondary' : 'outline'} size="sm">
                <CalendarIcon className="h-3 w-3 mr-1" />
                {t.weldchat.search.date}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={filters.after ? new Date(filters.after) : undefined}
                onSelect={(date) => {
                  setFilters((f) => ({ ...f, after: date ? startOfDayIso(date) : undefined }));
                  setDateOpen(false);
                }}
                disabled={(date) => date > new Date()}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* Active filter chips */}
        {filterChips.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {filterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 bg-muted px-2 py-0.5 rounded text-xs"
              >
                {chip.label}
                <Button variant="ghost" size="icon" onClick={() => removeFilter(chip.key)}>
                  <X className="h-3 w-3" />
                </Button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto p-4">
        {!searchEnabled && (
          <div className="text-center text-muted-foreground py-8">
            {t.weldchat.search.searchTip}
          </div>
        )}
        {isLoading && searchEnabled && (
          <div className="text-center text-muted-foreground py-8">{t.weldchat.search.searching}</div>
        )}
        {!isLoading && searchEnabled && messages.length === 0 && (
          <div className="text-center text-muted-foreground py-8">{t.weldchat.search.noResults}</div>
        )}
        <div className="space-y-1">
          {messages.map((msg) => {
            const { label, Icon } = channelLabel(msg);
            return (
              <Link
                key={msg.id}
                href={`/weldchat/${msg.channelId}?msg=${msg.id}`}
                className="block rounded-md px-3 py-2.5 hover:bg-muted/50 transition-colors"
              >
                <div className="inline-flex items-center gap-1 text-[11px] text-muted-foreground font-medium">
                  <Icon className="h-3 w-3" />
                  {label}
                </div>
                <div className="flex items-start gap-3 mt-1">
                  <Avatar className="h-8 w-8 flex-shrink-0 mt-0.5 !rounded-[10px]">
                    {msg.authorAvatar && <AvatarImage src={msg.authorAvatar} className="!rounded-[10px]" />}
                    <AvatarFallback className="text-xs !rounded-[10px]">
                      {(msg.authorName || '?')[0].toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold truncate">{msg.authorName}</span>
                      {msg.createdAt && (
                        <span className="text-[11px] text-muted-foreground flex-shrink-0">
                          {format(new Date(msg.createdAt), 'PP p')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-foreground/90 mt-0.5 break-words line-clamp-3">
                      {messagePreviewText(msg.content ?? '', memberNameByUserId)}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
