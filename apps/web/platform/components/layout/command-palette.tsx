/**
 * Centered command palette.
 *
 * Cmd/Ctrl+K (and the header search button) opens a dialog in the middle of
 * the screen. The empty state is commands — go to an app, open settings,
 * switch theme — not a dump of customers and contacts. Typing filters those
 * commands, and a query of two or more characters also searches records.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useClerk, useOrganization } from '@clerk/clerk-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { ArrowRight, Loader2, Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { useGlobalSearch } from '@/hooks/queries/use-global-search-queries';
import { useTheme } from '@/hooks/use-theme';
import { getAppLucideIcon } from '@/lib/apps/app-registry';
import { isDesktop } from '@/lib/desktop';
import { RESULT_TYPE_ICON, RESULT_TYPE_LABEL } from '@/lib/search/result-types';
import { pushRecent } from '@/lib/search/recents';
import { getRecentCommands, pushRecentCommand, type RecentCommand } from '@/lib/search/command-recents';
import { useEntitySheet, hasEntitySheetRenderer } from '@/components/entity-sheet';
import { Kbd } from '@weldsuite/ui/components/kbd';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import type { SearchEntityType, SearchResultItem } from '@weldsuite/core-api-client/schemas/search';
import {
  actionCommands,
  extraNavigationCommands,
  navigationCommandsForApps,
  pagesForModule,
  settingsCommands,
  visibleCommands,
  type PaletteCommand,
  type PaletteGroup,
} from './palette-commands';

type Listener = () => void;

let paletteOpen = false;
const paletteListeners = new Set<Listener>();

function emitPalette() {
  for (const listener of paletteListeners) listener();
}

export function subscribeCommandPalette(listener: Listener) {
  paletteListeners.add(listener);
  return () => {
    paletteListeners.delete(listener);
  };
}

export function getCommandPaletteOpen() {
  return paletteOpen;
}

export function setCommandPaletteOpen(next: boolean) {
  if (paletteOpen === next) return;
  paletteOpen = next;
  emitPalette();
}

export function openCommandPalette() {
  setCommandPaletteOpen(true);
}

export function toggleCommandPalette() {
  setCommandPaletteOpen(!paletteOpen);
}

function useCommandPaletteOpen() {
  return useSyncExternalStore(subscribeCommandPalette, getCommandPaletteOpen, () => false);
}

export function CommandPaletteTrigger({ className }: { className?: string }) {
  const { t } = useI18n();
  const open = useCommandPaletteOpen();
  const label = t.sweep.shared.commandPalette.placeholder;

  return (
    <button
      type="button"
      data-testid="cmdk-trigger"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => openCommandPalette()}
      className={
        className ??
        'flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent/50 hover:text-foreground'
      }
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="flex items-center gap-0.5">
        <Kbd className="text-base flex items-center justify-center pt-0.5">⌘</Kbd>
        <Kbd className="text-[10px] flex items-center justify-center">K</Kbd>
      </span>
    </button>
  );
}

const GROUP_ORDER: PaletteGroup[] = ['actions', 'navigation', 'settings'];

export function CommandPalette() {
  const { t } = useI18n();
  const open = useCommandPaletteOpen();
  const [query, setQuery] = useState('');
  const router = useRouter();
  const { organization } = useOrganization();
  const workspaceId = organization?.id ?? null;
  const { signOut } = useClerk();
  const { can, isOwner } = usePermissions();
  const { data: installedApps = [] } = useInstalledApps();
  const { resolvedTheme, setTheme } = useTheme();
  const { open: openEntitySheet } = useEntitySheet();
  const newTabRef = useRef(false);
  const copy = t.sweep.shared.commandPalette;

  const [recents, setRecents] = useState<RecentCommand[]>([]);
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    setRecents(getRecentCommands(workspaceId));
  }, [open, workspaceId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.repeat) return;
      event.preventDefault();
      toggleCommandPalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const trimmed = query.trim();
  const { data, isFetching, isPlaceholderData } = useGlobalSearch(query, {
    enabled: open && trimmed.length >= 2,
    limit: 3,
  });

  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  const installed = installedApps.map((app) => ({
    appCode: app.appCode,
    name: app.name,
    appType: app.appType,
  }));
  const installedCodes = new Set(installed.map((app) => app.appCode));
  const canSee = (permission: string | undefined) => !permission || isOwner || can(permission);

  const commands = visibleCommands([
    ...actionCommands(t, theme),
    ...extraNavigationCommands(t),
    ...navigationCommandsForApps(installed, (code) => pagesForModule(code, t), getAppLucideIcon, canSee),
    ...settingsCommands(t, installedCodes, { includeDesktop: isDesktop() }),
  ], query);

  const byGroup = (group: PaletteGroup) => commands.filter((command) => command.group === group);

  const recordItems: SearchResultItem[] = !isPlaceholderData && trimmed.length >= 2
    ? (data?.data ?? []).flatMap((group) => group.items).slice(0, 8)
    : [];

  const showSearching = trimmed.length >= 2 && isFetching && recordItems.length === 0;
  const showEmpty = commands.length === 0 && recordItems.length === 0 && !showSearching && trimmed.length > 0;
  const showRecents = trimmed.length === 0 && recents.length > 0;

  const close = useCallback(() => {
    setQuery('');
    setCommandPaletteOpen(false);
  }, []);

  const captureClickIntent = useCallback((event: ReactMouseEvent | ReactKeyboardEvent) => {
    if ('button' in event) {
      newTabRef.current = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    } else {
      newTabRef.current = event.metaKey || event.ctrlKey || event.shiftKey;
    }
  }, []);

  const goTo = useCallback(
    (href: string, recent?: Omit<RecentCommand, 'ts'>) => {
      const newTab = newTabRef.current;
      newTabRef.current = false;
      if (recent) pushRecentCommand(workspaceId, recent);
      close();
      if (newTab) {
        window.open(href, '_blank', 'noopener');
        return;
      }
      router.push(href);
    },
    [workspaceId, router, close],
  );

  const runCommand = useCallback(
    (command: PaletteCommand) => {
      if (command.run === 'toggle-theme') {
        setTheme(theme === 'dark' ? 'light' : 'dark');
        close();
        return;
      }
      if (command.run === 'sign-out') {
        close();
        void signOut({ redirectUrl: '/auth/login' });
        return;
      }
      if (!command.href) return;
      goTo(command.href, {
        id: command.id,
        title: command.title,
        subtitle: command.subtitle,
        href: command.href,
      });
    },
    [theme, setTheme, signOut, close, goTo],
  );

  const goToRecord = useCallback(
    (item: SearchResultItem) => {
      pushRecent(workspaceId, {
        id: item.id,
        type: item.type,
        title: item.title,
        subtitle: item.subtitle ?? null,
        url: item.url,
      });
      const newTab = newTabRef.current;
      newTabRef.current = false;
      close();
      if (newTab) {
        window.open(item.url, '_blank', 'noopener');
        return;
      }
      if (hasEntitySheetRenderer(item.type)) {
        openEntitySheet(item.type, item.id);
      } else {
        router.push(item.url);
      }
    },
    [workspaceId, close, openEntitySheet, router],
  );

  const groupLabel: Record<PaletteGroup, string> = {
    actions: copy.actions,
    navigation: copy.goTo,
    settings: t.sweep.shared.settings,
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setCommandPaletteOpen(true) : close())}>
      <DialogContent
        data-testid="command-palette"
        showCloseButton={false}
        className="top-[50%] left-[50%] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">{copy.title}</DialogTitle>
        <DialogDescription className="sr-only">{copy.description}</DialogDescription>
        <Command shouldFilter={false} loop>
          <CommandInput
            autoFocus
            data-testid="cmdk-input"
            placeholder={copy.placeholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-[min(420px,50vh)]">
            {showEmpty && <CommandEmpty>{t.sweep.shared.noResultsFound}</CommandEmpty>}

            {showRecents && (
              <CommandGroup heading={t.sweep.shared.recent}>
                {recents.map((recent) => (
                  <CommandItem
                    key={recent.id}
                    value={`recent:${recent.id}`}
                    onMouseDown={captureClickIntent}
                    onAuxClick={captureClickIntent}
                    onKeyDown={captureClickIntent}
                    onSelect={() =>
                      goTo(recent.href, {
                        id: recent.id,
                        title: recent.title,
                        subtitle: recent.subtitle,
                        href: recent.href,
                      })
                    }
                  >
                    <ArrowRight className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{recent.title}</span>
                    {recent.subtitle && (
                      <span className="ml-auto truncate text-xs text-muted-foreground">{recent.subtitle}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {GROUP_ORDER.map((group) => {
              const items = byGroup(group);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={group} heading={groupLabel[group]}>
                  {items.map((command) => {
                    const Icon = command.icon;
                    return (
                      <CommandItem
                        key={command.id}
                        value={command.id}
                        onMouseDown={captureClickIntent}
                        onAuxClick={captureClickIntent}
                        onKeyDown={captureClickIntent}
                        onSelect={() => runCommand(command)}
                      >
                        <Icon className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{command.title}</span>
                        {command.subtitle && (
                          <span className="ml-auto max-w-[45%] truncate pl-3 text-xs text-muted-foreground">
                            {command.subtitle}
                          </span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}

            {recordItems.length > 0 && (
              <CommandGroup heading={copy.records}>
                {recordItems.map((item) => {
                  const Icon = RESULT_TYPE_ICON[item.type] ?? Search;
                  const typeLabel = RESULT_TYPE_LABEL[item.type as SearchEntityType] ?? item.type;
                  return (
                    <CommandItem
                      key={`${item.type}-${item.id}`}
                      value={`record ${item.type} ${item.id}`}
                      onMouseDown={captureClickIntent}
                      onAuxClick={captureClickIntent}
                      onKeyDown={captureClickIntent}
                      onSelect={() => goToRecord(item)}
                    >
                      <Icon className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{typeLabel}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {showSearching && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.sweep.shared.searching}
              </div>
            )}
          </CommandList>
        </Command>
        <div className="flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {copy.navigate}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd>
            {copy.select}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>esc</Kbd>
            {copy.close}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
