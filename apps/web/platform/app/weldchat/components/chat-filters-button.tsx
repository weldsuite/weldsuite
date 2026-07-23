import { useState } from 'react';
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
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { useChatContext, type FilterType } from './chat-context';

/**
 * Filter button + popover for chat surfaces. Reads / writes the shared
 * `useChatContext()` filters so the list below re-filters live. Must be
 * rendered inside a `ChatContext.Provider`.
 */
export function ChatFiltersButton() {
  const { t } = useI18n();
  const st = useTranslations();
  const { filters, setFilters } = useChatContext();

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
  const [filterOpen, setFilterOpen] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [fromOpen, setFromOpen] = useState(false);
  const [fromQuery, setFromQuery] = useState('');
  const { data: membersData } = useWorkspaceMembers();
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
    <Popover open={filterOpen} onOpenChange={setFilterOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={hasActiveFilters ? 'sm' : 'icon'}
          className={cn(
            'h-8',
            hasActiveFilters ? 'gap-1.5 px-2' : 'w-8',
            filterOpen && 'bg-accent',
          )}
          title={t.weldchat.channelHeader.filter}
        >
          <SlidersHorizontal className="h-4 w-4" />
          {hasActiveFilters && (
            <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-[5px]">
              {activeFilterCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={4} className="w-[300px] p-0">
        <div className="p-3 border-b">
          <div className="mb-3">
            <span className="text-sm font-semibold">{t.weldchat.chatFilters.filterMessages}</span>
          </div>

          <div className="space-y-2">
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
          <div className="px-3 py-2 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={clearFilters} className="h-8">
              {t.weldchat.chatFilters.reset}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
