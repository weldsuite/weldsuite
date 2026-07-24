import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  CalendarIcon,
  Check,
  File,
  Hash,
  Image as ImageIcon,
  Link2,
  MessagesSquare,
  Search,
  SlidersHorizontal,
  User,
  X,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@weldsuite/ui/components/select';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { useMessages, useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { useChatContext, type FilterType, type ChatFilters } from './chat-context';

interface RawChatFilterAttachment {
  mimeType?: string;
}

interface RawChatFilterMessage {
  id: string;
  content?: string;
  authorName?: string;
  authorAvatar?: string | null;
  createdAt?: string;
  attachments?: RawChatFilterAttachment[];
}

function applyFilters(messages: RawChatFilterMessage[], filters: ChatFilters): RawChatFilterMessage[] {
  let out = messages;
  if (filters.type === 'messages') {
    out = out.filter((m) => !m.attachments?.length && m.content?.trim());
  } else if (filters.type === 'files') {
    out = out.filter((m) => m.attachments?.some((a) => !a.mimeType?.startsWith('image/')));
  } else if (filters.type === 'images') {
    out = out.filter((m) => m.attachments?.some((a) => a.mimeType?.startsWith('image/')));
  } else if (filters.type === 'links') {
    out = out.filter((m) => m.content && /https?:\/\/[^\s]+/.test(m.content));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    out = out.filter((m) => m.content?.toLowerCase().includes(q));
  }
  if (filters.from.length > 0) {
    const names = new Set(filters.from.map((n) => n.toLowerCase()));
    out = out.filter((m) => {
      const name = m.authorName?.toLowerCase();
      return name ? names.has(name) : false;
    });
  }
  if (filters.date) {
    const filterDateStr = filters.date.toDateString();
    out = out.filter((m) => new Date(m.createdAt ?? '').toDateString() === filterDateStr);
  }
  return out;
}

function jumpToMessageInList(messageId: string) {
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
}

export function ChatFiltersPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n();
  const st = useTranslations();
  const { filters, setFilters, setRightPanel, activeChannelId } = useChatContext();

  const setFiltersRef = useRef(setFilters);
  setFiltersRef.current = setFilters;
  useEffect(() => {
    return () => {
      setFiltersRef.current({ type: 'all', search: '', from: [], date: undefined });
    };
  }, []);

  const FILTER_OPTIONS: {
    value: FilterType;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
    { value: 'all', label: t.weldchat.chatFilters.filterTypes.all, icon: Hash },
    { value: 'messages', label: t.weldchat.chatFilters.filterTypes.messages, icon: MessagesSquare },
    { value: 'files', label: t.weldchat.chatFilters.filterTypes.files, icon: File },
    { value: 'images', label: t.weldchat.chatFilters.filterTypes.images, icon: ImageIcon },
    { value: 'links', label: t.weldchat.chatFilters.filterTypes.links, icon: Link2 },
  ];
  const navigate = useNavigate();
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [fromOpen, setFromOpen] = useState(false);
  const [fromQuery, setFromQuery] = useState('');
  const { data: membersData } = useWorkspaceMembers();
  const { data: messagesData, isLoading: messagesLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useMessages(activeChannelId ?? '');

  const filteredMessages = useMemo(() => {
    const pages = messagesData?.pages as
      | Array<{ data?: { messages?: RawChatFilterMessage[] } | RawChatFilterMessage[] }>
      | undefined;
    const raw = pages?.flatMap((p) => {
      const d = p.data;
      return Array.isArray(d) ? d : (d?.messages ?? []);
    }) ?? [];
    return applyFilters(raw, filters);
  }, [messagesData, filters]);
  const members = (() => {
    type RawMember = { name?: string; email?: string; picture?: string };
    const seen = new Set<string>();
    const list: { label: string; avatar?: string }[] = [];
    for (const m of (membersData?.data ?? []) as RawMember[]) {
      const label = m.name || m.email;
      if (!label || seen.has(label)) continue;
      seen.add(label);
      list.push({ label, avatar: m.picture });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  })();

  const activeFilterCount =
    (filters.type !== 'all' ? 1 : 0) +
    (filters.search ? 1 : 0) +
    (filters.from.length > 0 ? 1 : 0) +
    (filters.date ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;

  const clearFilters = () => {
    setFilters({ type: 'all', search: '', from: [], date: undefined });
    setFromQuery('');
  };

  const togglePerson = (label: string) => {
    const next = filters.from.includes(label)
      ? filters.from.filter((n) => n !== label)
      : [...filters.from, label];
    setFilters({ ...filters, from: next });
    setFromQuery('');
  };

  const removePerson = (label: string) => {
    setFilters({ ...filters, from: filters.from.filter((n) => n !== label) });
  };

  return (
    <div className="flex flex-col h-full">
      {!embedded && (
        <div className="flex items-center justify-between px-4 border-b h-[53px] flex-shrink-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            <h3 className="font-semibold text-sm">{t.weldchat.chatFilters.filterMessages}</h3>
            {hasActiveFilters && (
              <span
                className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-[5px]"
                style={{ transform: 'translateY(0.5px)' }}
              >
                {activeFilterCount}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRightPanel(null)}
            title={t.weldchat.chatFilters.close}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      <div className="border-b flex-shrink-0">
        <div className="p-3 space-y-2">
          <div className="relative">
            {(() => {
              const ActiveIcon =
                FILTER_OPTIONS.find((o) => o.value === filters.type)?.icon || Hash;
              return (
                <ActiveIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none z-10" />
              );
            })()}
            <Select
              value={filters.type}
              onValueChange={(v) => setFilters({ ...filters, type: v as FilterType })}
            >
              <SelectTrigger className="pl-8">
                <span>
                  {FILTER_OPTIONS.find((o) => o.value === filters.type)?.label || t.weldchat.chatFilters.filterTypes.all}
                </span>
              </SelectTrigger>
              <SelectContent>
                {FILTER_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <SelectItem key={opt.value} value={opt.value}>
                      <div className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span>{opt.label}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              placeholder={t.weldchat.chatFilters.searchKeywords}
              className="pl-8"
            />
          </div>

          <Popover
            open={fromOpen}
            onOpenChange={(open) => {
              setFromOpen(open);
              if (!open) setFromQuery('');
            }}
          >
            <PopoverAnchor asChild>
              <div
                data-from-anchor
                onClick={(e) => {
                  const input = (e.currentTarget as HTMLElement).querySelector(
                    'input',
                  ) as HTMLInputElement | null;
                  input?.focus();
                  setFromOpen(true);
                }}
                className={cn(
                  'flex flex-wrap items-center gap-1 min-h-9 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm',
                  'focus-within:ring-[3px] focus-within:ring-ring/50 focus-within:border-ring',
                )}
              >
                {filters.from.length === 0 && (
                  <User className="h-3.5 w-3.5 text-muted-foreground ml-0.5" />
                )}
                {filters.from.map((name) => {
                  const m = members.find((mem) => mem.label === name);
                  return (
                    <Badge
                      key={name}
                      variant="secondary"
                      className="gap-1.5 pl-1 pr-1.5 py-1 !rounded-md"
                    >
                      <Avatar className="h-[18px] w-[18px] !rounded-[6px]">
                        {m?.avatar && (
                          <AvatarImage src={m.avatar} alt={name} className="!rounded-[6px]" />
                        )}
                        <AvatarFallback className="!rounded-[6px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                          {name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {name}
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          removePerson(name);
                        }}
                        className="rounded-sm p-0.5 text-gray-600 dark:text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        aria-label={st('sweep.weldchat.chatFilters.removePerson', { name })}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </Badge>
                  );
                })}
                <input
                  value={fromQuery}
                  onChange={(e) => {
                    setFromQuery(e.target.value);
                    setFromOpen(true);
                  }}
                  onFocus={() => setFromOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && fromQuery === '' && filters.from.length > 0) {
                      removePerson(filters.from[filters.from.length - 1]!);
                    }
                  }}
                  placeholder={filters.from.length === 0 ? t.weldchat.chatFilters.from : ''}
                  className="flex-1 min-w-[80px] bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </div>
            </PopoverAnchor>
            <PopoverContent
              className="w-[268px] p-1"
              align="start"
              sideOffset={4}
              onOpenAutoFocus={(e) => e.preventDefault()}
              onInteractOutside={(e) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest('[data-from-anchor]')) {
                  e.preventDefault();
                }
              }}
            >
              {(() => {
                const q = fromQuery.toLowerCase();
                const filtered = q
                  ? members.filter((m) => m.label.toLowerCase().includes(q))
                  : members;
                return (
                  <div className="max-h-[220px] overflow-auto">
                    {filtered.length === 0 ? (
                      <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                        {t.weldchat.chatFilters.noPeopleFound}
                      </div>
                    ) : (
                      filtered.map((m) => {
                        const selected = filters.from.includes(m.label);
                        return (
                          <Button
                            key={m.label}
                            type="button"
                            variant="ghost"
                            onClick={() => togglePerson(m.label)}
                            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent text-left"
                          >
                            <Avatar className="h-5 w-5 !rounded-[7px]">
                              {m.avatar && <AvatarImage src={m.avatar} className="!rounded-[7px]" />}
                              <AvatarFallback className="text-[9px] !rounded-[7px]">
                                {m.label[0]?.toUpperCase() ?? '?'}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate">{m.label}</span>
                            <Check
                              className={cn(
                                'ml-auto h-4 w-4 shrink-0',
                                selected ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                          </Button>
                        );
                      })
                    )}
                  </div>
                );
              })()}
            </PopoverContent>
          </Popover>

          <div className="relative">
            <CalendarIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none z-10" />
            <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'w-full justify-start font-normal pl-8',
                    !filters.date && 'text-muted-foreground',
                  )}
                >
                  {filters.date ? filters.date.toLocaleDateString() : t.weldchat.chatFilters.selectDate}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto overflow-hidden p-0" align="start">
                <Calendar
                  mode="single"
                  selected={filters.date}
                  defaultMonth={filters.date}
                  captionLayout="dropdown"
                  onSelect={(date) => {
                    setFilters({ ...filters, date });
                    setDatePickerOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

      {hasActiveFilters && (
        <div className="px-4 h-9 flex items-center justify-between flex-shrink-0 border-b bg-muted/30">
          <span className="text-xs font-medium text-muted-foreground">
            {filteredMessages.length} {filteredMessages.length === 1 ? t.weldchat.chatFilters.result : t.weldchat.chatFilters.results}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={clearFilters}
            className="h-7 px-2 text-xs"
          >
            {t.weldchat.chatFilters.reset}
          </Button>
        </div>
      )}

      <ScrollArea className="flex-1">
        {!hasActiveFilters && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-muted-foreground pointer-events-none">
            <p className="text-sm font-medium">{t.weldchat.chatFilters.noFiltersApplied}</p>
            <p className="text-xs mt-1 text-center">
              {t.weldchat.chatFilters.noFiltersHint}
            </p>
          </div>
        )}
        {hasActiveFilters && !activeChannelId && (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-muted-foreground">
            <p className="text-sm">{t.weldchat.chatFilters.openConversation}</p>
          </div>
        )}
        {hasActiveFilters && activeChannelId && messagesLoading && (
          <div className="text-center text-muted-foreground py-12 text-sm">{t.weldchat.chatFilters.loading}</div>
        )}
        {hasActiveFilters && activeChannelId && !messagesLoading && filteredMessages.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-4 text-muted-foreground pointer-events-none">
            <p className="text-sm font-medium">{t.weldchat.chatFilters.noMatchingMessages}</p>
            <p className="text-xs mt-1 text-center">{t.weldchat.chatFilters.noMatchingMessagesHint}</p>
          </div>
        )}
        {hasActiveFilters && activeChannelId && filteredMessages.map((msg) => {
          const hasImage = msg.attachments?.some((a) => a.mimeType?.startsWith('image/'));
          const hasFile = msg.attachments?.some((a) => !a.mimeType?.startsWith('image/'));
          const hasLink = msg.content && /https?:\/\/[^\s]+/.test(msg.content);
          const CategoryIcon =
            hasImage ? ImageIcon :
            hasFile ? File :
            hasLink ? Link2 :
            MessagesSquare;
          return (
            <div
              key={msg.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                navigate({ to: '/weldchat/$channelId', params: { channelId: activeChannelId } });
                jumpToMessageInList(msg.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate({ to: '/weldchat/$channelId', params: { channelId: activeChannelId } });
                  jumpToMessageInList(msg.id);
                }
              }}
              className={cn(
                'flex items-start gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group/msg relative',
              )}
            >
              <div className="flex-1 min-w-0 flex items-start gap-3">
                <div className="relative flex-shrink-0 mt-0.5">
                  <Avatar className="h-6 w-6 !rounded-[8px]">
                    {msg.authorAvatar && (
                      <AvatarImage src={msg.authorAvatar} className="!rounded-[8px]" />
                    )}
                    <AvatarFallback className="text-[10px] !rounded-[8px]">
                      {(msg.authorName || '?')[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="absolute -bottom-0.5 -right-0.5 h-[12px] w-[12px] rounded-full bg-background flex items-center justify-center">
                    <CategoryIcon className="h-2.5 w-2.5 text-foreground" />
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-snug truncate font-semibold text-foreground">
                    {msg.authorName}
                    {msg.createdAt && (
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        ·{' '}
                        {new Date(msg.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  {msg.content && (
                    <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words mt-0.5">
                      {msg.content}
                    </div>
                  )}
                  {(msg.attachments?.length ?? 0) > 0 && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {msg.attachments!.length} {msg.attachments!.length === 1 ? t.weldchat.chatFiltersPanel.attachment : t.weldchat.chatFiltersPanel.attachments}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {hasActiveFilters && activeChannelId && hasNextPage && (
          <div className="p-3 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="h-8"
            >
              {isFetchingNextPage ? t.weldchat.chatFilters.loadingMore : t.weldchat.chatFilters.loadMore}
            </Button>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
