/**
 * Inline global search — matches the existing UX:
 *  - centered input box in the header
 *  - dropdown popover directly under the input (NOT a fullscreen Dialog)
 *  - Cmd+K focuses the input
 *
 * Federated search backed by POST /api/search.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import { useOrganization } from '@clerk/clerk-react';
import { Search, Loader2 } from 'lucide-react';
import { Input } from '@weldsuite/ui/components/input';
import { Kbd } from '@weldsuite/ui/components/kbd';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useGlobalSearch } from '@/hooks/queries/use-global-search-queries';
import { RESULT_TYPE_ICON, RESULT_TYPE_LABEL } from '@/lib/search/result-types';
import { getRecents, pushRecent, type RecentItem } from '@/lib/search/recents';
import { useEntitySheet, hasEntitySheetRenderer } from '@/components/entity-sheet';
import type {
  SearchEntityType,
  SearchResultItem,
} from '@weldsuite/core-api-client/schemas/search';

export interface CommandPaletteHandle {
  focus: () => void;
  toggle: () => void;
}

export const CommandPalette = forwardRef<CommandPaletteHandle>(function CommandPalette(_, ref) {
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { organization } = useOrganization();
  const workspaceId = organization?.id ?? null;

  const { data, isFetching } = useGlobalSearch(query);

  const [recents, setRecents] = useState<RecentItem[]>([]);
  useEffect(() => {
    if (!open) return;
    setRecents(getRecents(workspaceId));
  }, [open, workspaceId]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        inputRef.current?.focus();
        setOpen(true);
      },
      toggle: () => {
        if (open) {
          inputRef.current?.blur();
          setOpen(false);
        } else {
          inputRef.current?.focus();
          setOpen(true);
        }
      },
    }),
    [open],
  );

  const { open: openEntitySheet } = useEntitySheet();
  const newTabRef = useRef(false);

  const goToResult = useCallback(
    (item: SearchResultItem | RecentItem) => {
      pushRecent(workspaceId, {
        id: item.id,
        type: item.type,
        title: item.title,
        subtitle: 'subtitle' in item ? item.subtitle ?? null : null,
        url: item.url,
      });
      const newTab = newTabRef.current;
      newTabRef.current = false;
      setQuery('');
      setOpen(false);
      inputRef.current?.blur();

      // Cmd/Ctrl/middle-click → open in new tab (browser convention)
      if (newTab) {
        window.open(item.url, '_blank', 'noopener');
        return;
      }

      // Sheet by default; navigate to the full page if no renderer registered
      if (hasEntitySheetRenderer(item.type)) {
        openEntitySheet(item.type, item.id);
      } else {
        router.push(item.url);
      }
    },
    [workspaceId, router, openEntitySheet],
  );

  const captureClickIntent = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    if ('button' in e) {
      newTabRef.current = e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
    } else {
      newTabRef.current = e.metaKey || e.ctrlKey || e.shiftKey;
    }
  }, []);

  const showRecents = !query.trim() && recents.length > 0;
  const groups = data?.data ?? [];
  const hasAnyResults = groups.some((g) => g.items.length > 0);

  return (
    <div className="relative w-full">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          placeholder={t('sweep.shared.searchAnythingPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setTimeout(() => setOpen(false), 100);
          }}
          className="pl-9 pr-16 h-9"
          data-testid="cmdk-input"
          suppressHydrationWarning
        />
        {!isFetching && !query && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center gap-0.5">
            <Kbd className="text-base flex items-center justify-center pt-0.5">⌘</Kbd>
            <Kbd className="text-[10px] flex items-center justify-center">K</Kbd>
          </div>
        )}
        {isFetching && query && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {open && (
        <div
          ref={popoverRef}
          onMouseDown={(e) => e.preventDefault()}
          className="absolute top-full mt-2 w-full z-50 rounded-md border bg-popover shadow-md max-h-[60vh] overflow-y-auto"
        >
          <Command shouldFilter={false}>
            <CommandList className="max-h-none">
              {showRecents && (
                <CommandGroup heading={t('sweep.shared.recent')}>
                  {recents.map((r) => {
                    const Icon = RESULT_TYPE_ICON[r.type as SearchEntityType] ?? Search;
                    return (
                      <CommandItem
                        key={`recent-${r.type}-${r.id}`}
                        value={`recent ${r.title} ${r.id}`}
                        onMouseDown={captureClickIntent}
                        onAuxClick={captureClickIntent}
                        onKeyDown={captureClickIntent}
                        onSelect={() => goToResult(r)}
                        className="cursor-pointer flex items-center gap-2"
                      >
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="font-medium truncate">{r.title}</span>
                          {r.subtitle && (
                            <span className="text-xs text-muted-foreground truncate">{r.subtitle}</span>
                          )}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {!showRecents && query.trim() && !hasAnyResults && !isFetching && (
                <CommandEmpty>{t('sweep.shared.noResultsFound')}</CommandEmpty>
              )}

              {!showRecents && query.trim() && isFetching && !hasAnyResults && (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t('sweep.shared.searching')}
                </div>
              )}

              {groups.map((group) => {
                if (group.items.length === 0) return null;
                const heading = RESULT_TYPE_LABEL[group.type] ?? group.type;
                return (
                  <CommandGroup key={group.type} heading={heading}>
                    {group.items.map((item) => {
                      const Icon = RESULT_TYPE_ICON[item.type] ?? Search;
                      return (
                        <CommandItem
                          key={`${item.type}-${item.id}`}
                          value={`${item.type} ${item.title} ${item.subtitle ?? ''} ${item.id}`}
                          onMouseDown={captureClickIntent}
                          onAuxClick={captureClickIntent}
                          onKeyDown={captureClickIntent}
                          onSelect={() => goToResult(item)}
                          className="cursor-pointer flex items-center gap-2"
                        >
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="font-medium truncate">{item.title}</span>
                            {item.subtitle && (
                              <span className="text-xs text-muted-foreground truncate">
                                {item.subtitle}
                              </span>
                            )}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
});
