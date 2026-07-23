import { useState, useMemo } from 'react';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { Search, User, Hash, Calendar, Paperclip, Pin, X } from 'lucide-react';
import { MessageItem } from '../components/message-item';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface SearchFilters {
  authorId?: string;
  channelId?: string;
  hasFile?: boolean;
  isPinned?: boolean;
  before?: string;
  after?: string;
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
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [filterInput, setFilterInput] = useState('');

  const searchEnabled = query.length >= 2;

  const { data, isLoading } = useQuery({
    queryKey: [...weldchatKeys.search(query), filters],
    queryFn: async () => {
      const client = await getClient();
      const params = new URLSearchParams({ q: query });
      if (filters.authorId) params.set('authorId', filters.authorId);
      if (filters.channelId) params.set('channelId', filters.channelId);
      if (filters.hasFile) params.set('hasFile', 'true');
      if (filters.isPinned) params.set('isPinned', 'true');
      if (filters.before) params.set('before', filters.before);
      if (filters.after) params.set('after', filters.after);
      return client.get<{ data: { messages: any[]; total: number } }>(
        `/chat-search?${params.toString()}`,
      );
    },
    enabled: searchEnabled,
  });

  // The search route (both legacy and app-api) answers with
  // `{ data: { messages, total } }` — reading `data.data` handed the render an
  // object and blew up on `.map`. Unwrap `messages` properly.
  const messages = data?.data?.messages ?? [];

  const filterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string }> = [];
    if (filters.authorId) chips.push({ key: 'authorId', label: st('sweep.weldchat.searchPage.filterFrom', { value: filters.authorId }) });
    if (filters.channelId) chips.push({ key: 'channelId', label: st('sweep.weldchat.searchPage.filterIn', { value: filters.channelId }) });
    if (filters.hasFile) chips.push({ key: 'hasFile', label: st('sweep.weldchat.searchPage.filterHasFile') });
    if (filters.isPinned) chips.push({ key: 'isPinned', label: st('sweep.weldchat.searchPage.filterPinned') });
    if (filters.after) chips.push({ key: 'after', label: st('sweep.weldchat.searchPage.filterAfter', { value: filters.after }) });
    if (filters.before) chips.push({ key: 'before', label: st('sweep.weldchat.searchPage.filterBefore', { value: filters.before }) });
    return chips;
  }, [filters, st]);

  const removeFilter = (key: string) => {
    setFilters((prev) => {
      const next = { ...prev };
      delete (next as any)[key];
      return next;
    });
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const date = prompt(t.weldchat.search.afterDate);
              if (date) setFilters((f) => ({ ...f, after: date }));
            }}
          >
            <Calendar className="h-3 w-3 mr-1" />
            {t.weldchat.search.date}
          </Button>
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
          {messages.map((msg: any) => (
            <MessageItem key={msg.id} message={msg} showChannel />
          ))}
        </div>
      </div>
    </div>
  );
}
