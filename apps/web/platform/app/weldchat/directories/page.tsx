import { useCallback, useMemo, useState } from 'react';
import { Copy, EllipsisVertical, MessageSquare, User } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';
import { usePresence } from '@/contexts/presence-context';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useNavigate } from '@tanstack/react-router';
import { useDmChannels, useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { isPendingInvitee } from '../lib/dm-availability';
import {
  EntityList,
  EmptyStateIllustration,
  type ActiveFilter,
  type FilterConfig,
  type HeaderColumn,
} from '@/components/entity-list';

/** The Status filter: whether someone has joined the workspace or is still invited. */
type DirectoryStatus = 'active' | 'invited';
const STATUS_FIELD = 'status';

/** Whether `item` passes every complete filter pill (`is` / `is not` a status). */
function matchesFilters(item: { isInvited: boolean }, filters: ActiveFilter[]): boolean {
  const status: DirectoryStatus = item.isInvited ? 'invited' : 'active';
  return filters.every((f) => {
    if (f.field !== STATUS_FIELD || !f.operator || !f.value) return true;
    return (f.operator === 'is') === (status === f.value);
  });
}

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
  /** Invited but not joined yet: listed, but can't be messaged until they accept. */
  isInvited: boolean;
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

  // "Last activity" is the last message in your DM with them: the members list
  // carries no activity of its own.
  const { data: dmsData } = useDmChannels();
  const lastDmMessageAt = useMemo(() => {
    const byUser = new Map<string, Date>();
    for (const dm of dmsData?.data ?? []) {
      const others = dm.otherMembers ?? [];
      const [other] = others;
      if (!other || others.length !== 1 || !dm.lastMessageAt) continue;
      byUser.set(other.userId, new Date(dm.lastMessageAt));
    }
    return byUser;
  }, [dmsData]);

  const items: DirectoryItem[] = useMemo(() => {
    const allPeople: DirectoryItem[] = rawMembers.map((m) => ({
      id: `person:${m.id}`,
      name: m.name || m.email || st('sweep.weldchat.directories.unknownPerson'),
      email: m.email,
      picture: m.picture,
      status: m.status,
      userId: m.userId ?? m.id,
      lastMessageAt: lastDmMessageAt.get(m.userId ?? m.id) ?? (m.lastMessageAt ? new Date(m.lastMessageAt) : null),
      isInvited: isPendingInvitee(m),
    }));

    // People are loaded as a single list with no server-side search or
    // filtering, so narrow them client-side.
    const q = debouncedSearch.trim().toLowerCase();
    return allPeople.filter(
      (p) =>
        matchesFilters(p, activeFilters) &&
        (!q || p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q)),
    );
  }, [rawMembers, lastDmMessageAt, debouncedSearch, activeFilters, st]);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.directoriesPage.nameHeader, width: 'flex-1 min-w-0' },
    { id: 'email', header: t.directoriesPage.emailHeader, width: 'hidden lg:block w-[260px]' },
    { id: 'last', header: t.directoriesPage.lastActivityHeader, width: 'w-[120px] flex-shrink-0' },
  ], [t]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: STATUS_FIELD,
      label: st('common.labels.status'),
      options: [
        { value: 'active', label: t.directoriesPage.statusActive },
        { value: 'invited', label: t.dmCreate.invited },
      ],
    },
  ], [t, st]);

  const copyEmail = useCallback((email: string) => {
    navigator.clipboard.writeText(email).then(
      () => toast.success(st('sweep.shared.emailCopiedToClipboard')),
      () => toast.error(st('sweep.shared.failedToCopy')),
    );
  }, [st]);

  // The list's standard row: the whole row opens the DM, one line per cell
  // under its header, and a ⋯ menu in the last 40px the header keeps free.
  const renderRow = useCallback((item: DirectoryItem) => {
    const openDm = () =>
      navigate({ to: '/weldchat/dm/$userId', params: { userId: item.userId ?? item.id } });
    return (
      <div
        key={item.id}
        data-testid="directory-row"
        // An invitee can't be messaged until they accept, so their row opens nothing.
        title={item.isInvited ? t.dmCreate.invitedHint : undefined}
        className={cn(
          'group relative flex items-center gap-4 border-b border-gray-200/70 px-4 py-3 dark:border-border',
          item.isInvited ? 'opacity-60' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-secondary/50',
        )}
      >
        {!item.isInvited && <RowOverlayButton label={item.name} onClick={openDm} />}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="pointer-events-none relative flex-shrink-0">
            <Avatar className="h-6 w-6">
              {item.picture && <AvatarImage src={item.picture} />}
              <AvatarFallback className="text-[10px]">
                {(item.name || item.email || '?')[0]?.toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <StatusDot
              status={presenceMap[item.userId ?? '']?.status}
              className="absolute -bottom-0.5 -right-0.5 h-[10px] w-[10px] border-2"
            />
          </span>
          <span className="truncate text-sm font-medium text-gray-900 dark:text-foreground">{item.name}</span>
        </div>
        <div className="hidden w-[260px] min-w-0 lg:block">
          <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">{item.email}</span>
        </div>
        <div className="w-[120px] flex-shrink-0">
          <span className={cn('text-sm', !item.isInvited && item.lastMessageAt ? undefined : 'text-muted-foreground')}>
            {item.isInvited ? t.dmCreate.invited : formatRelative(item.lastMessageAt, st)}
          </span>
        </div>
        {/* h-7 holds the row's 53px height on rows without a menu too. */}
        <div className="relative z-[1] flex h-7 w-[40px] items-center justify-end">
          {(!item.isInvited || item.email) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${st('common.actions.openMenu')}: ${item.name}`}
                  className="h-7 w-7 p-0 text-gray-400 opacity-0 hover:text-gray-600 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <EllipsisVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!item.isInvited && (
                  <DropdownMenuItem onSelect={openDm}>
                    <MessageSquare className="mr-0.5 h-4 w-4" />
                    {t.messageInput.sendMessage}
                  </DropdownMenuItem>
                )}
                {item.email && (
                  <DropdownMenuItem onSelect={() => copyEmail(item.email!)}>
                    <Copy className="mr-0.5 h-4 w-4" />
                    {st('sweep.shared.copyEmail')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  }, [navigate, presenceMap, st, t, copyEmail]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
    <EntityList<DirectoryItem>
      items={items}
      isLoading={membersLoading}
      error={null}
      headerColumns={headerColumns}
      filters={filterConfigs}
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
