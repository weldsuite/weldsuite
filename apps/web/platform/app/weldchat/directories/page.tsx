import { useCallback, useMemo, useState } from 'react';
import { User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import { usePresence } from '@/contexts/presence-context';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useNavigate } from '@tanstack/react-router';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import {
  EntityList,
  EmptyStateIllustration,
  type ActiveFilter,
  type HeaderColumn,
} from '@/components/entity-list';

function formatRelative(
  date: Date | null | undefined,
  st: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return st('sweep.weldchat.relativeTime.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return st('sweep.weldchat.relativeTime.justNow');
  if (mins < 60) return st('sweep.weldchat.relativeTime.minutesAgo', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return st('sweep.weldchat.relativeTime.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return st('sweep.weldchat.relativeTime.daysAgo', { count: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return st('sweep.weldchat.relativeTime.weeksAgo', { count: weeks });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface DirectoryItem {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  status?: string;
  userId?: string;
  lastMessageAt?: Date | null;
}

export default function DirectoriesPage() {
  const t = getTranslations('weldchat');
  const st = useTranslations();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const debouncedSearch = useDebounce(searchQuery, 300);
  const { presenceMap } = usePresence();

  useBreadcrumbs([
    { label: st('sweep.weldchat.breadcrumb.chat'), href: '/weldchat' },
    { label: t.directories ?? 'Directories' },
  ]);

  const { data: membersData, isLoading: membersLoading } = useWorkspaceMembers();
  const rawMembers = useMemo(() => membersData?.data ?? [], [membersData]);

  const items: DirectoryItem[] = useMemo(() => {
    const allPeople: DirectoryItem[] = rawMembers.map((m) => ({
      id: `person:${m.id}`,
      name: m.name || m.email || st('sweep.weldchat.directories.unknownPerson'),
      email: m.email,
      picture: m.picture,
      status: m.status,
      userId: m.userId ?? m.id,
      lastMessageAt: m.lastMessageAt ? new Date(m.lastMessageAt) : null,
    }));

    // People are loaded as a single list with no server-side search support,
    // so narrow them client-side as the user types.
    const q = debouncedSearch.trim().toLowerCase();
    return q
      ? allPeople.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.email ?? '').toLowerCase().includes(q),
        )
      : allPeople;
  }, [rawMembers, debouncedSearch, st]);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.directoriesPage?.nameHeader ?? 'Name', width: 'flex-1 min-w-0' },
    { id: 'last', header: t.directoriesPage?.lastActivityHeader ?? 'Last activity', width: 'w-[120px] flex-shrink-0' },
  ], [t]);

  const renderRow = useCallback((item: DirectoryItem) => {
    return (
      <div
        key={item.id}
        onClick={() =>
          navigate({
            to: '/weldchat/dm/$userId',
            params: { userId: item.userId ?? item.id },
          })
        }
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <Avatar className="h-6 w-6 !rounded-[8px]">
              {item.picture && (
                <AvatarImage src={item.picture} className="!rounded-[8px]" />
              )}
              <AvatarFallback className="text-[10px] !rounded-[8px]">
                {(item.name || item.email || '?')[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <StatusDot
              status={presenceMap[item.userId ?? '']?.status}
              showTooltip
              className="absolute -bottom-0.5 -right-0.5 h-[10px] w-[10px] border-2"
            />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
              {item.name}
            </span>
          </div>
        </div>

        <div className="w-[120px] flex-shrink-0">
          <span className={cn(
            'text-sm',
            item.lastMessageAt ? 'text-gray-600 dark:text-muted-foreground' : 'text-gray-400',
          )}>
            {formatRelative(item.lastMessageAt, st)}
          </span>
        </div>

      </div>
    );
  }, [navigate, presenceMap, st]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
    <EntityList<DirectoryItem>
      items={items}
      isLoading={membersLoading}
      error={null}
      headerColumns={headerColumns}
      filters={[]}
      renderRow={renderRow}
      searchPlaceholder={t.directoriesPage?.searchPlaceholder ?? 'Search directories...'}
      searchFields={['name', 'email']}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
              <defs>
                <clipPath id="dir-clip-left"><circle cx="36" cy="46" r="13.4" /></clipPath>
                <clipPath id="dir-clip-right"><circle cx="84" cy="46" r="13.4" /></clipPath>
                <clipPath id="dir-clip-center"><circle cx="60" cy="56" r="15.4" /></clipPath>
              </defs>
              <circle cx="36" cy="46" r="14" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
              <g clipPath="url(#dir-clip-left)">
                <circle cx="36" cy="42" r="5.5" className="fill-gray-200 dark:fill-white/15" />
                <path d="M24 60a12 12 0 0 1 24 0v4H24z" className="fill-gray-200 dark:fill-white/15" />
              </g>
              <circle cx="84" cy="46" r="14" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
              <g clipPath="url(#dir-clip-right)">
                <circle cx="84" cy="42" r="5.5" className="fill-gray-200 dark:fill-white/15" />
                <path d="M72 60a12 12 0 0 1 24 0v4H72z" className="fill-gray-200 dark:fill-white/15" />
              </g>
              <circle cx="60" cy="56" r="16" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
              <g clipPath="url(#dir-clip-center)">
                <circle cx="60" cy="51" r="6.5" className="fill-gray-200 dark:fill-white/15" />
                <path d="M46 72a14 14 0 0 1 28 0v4H46z" className="fill-gray-200 dark:fill-white/15" />
              </g>
            </svg>
          </EmptyStateIllustration>
        ),
        title: t.directoriesPage?.noDirectoryEntries ?? 'No directory entries',
        description: t.directoriesPage?.noDirectoryEntriesHint ?? 'People in your workspace will appear here.',
      }}
      noResultsState={{
        icon: <User className="w-4 h-4 text-gray-400" />,
        title: t.directoriesPage?.noMatches ?? 'No matches',
        description: t.directoriesPage?.noMatchesHint ?? "We couldn't find anyone matching your filter.",
      }}
    />
    </div>
  );
}
