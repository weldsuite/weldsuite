import { useCallback, useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useLocationSearch } from '@/hooks/use-location-search';
import type { MapboxSuggestion } from '@/app/weldcalendar/lib/mapbox-search';

/** Country fields only accept countries; city/state fields accept finer-grained places. */
export type LocationScope = 'country' | 'city';

const SCOPE_TYPES: Record<LocationScope, string> = {
  country: 'country',
  city: 'place,region,district,locality',
};

interface FilterLocationInputProps {
  id: string;
  /** Currently applied location values (provider sends these verbatim). */
  value: string[];
  /** Fires with the full selected list (empty array = not applied). */
  onChange: (values: string[]) => void;
  scope: LocationScope;
  placeholder?: string;
}

/**
 * Multi-select location field backed by Mapbox Search Box autocomplete.
 *
 * The field is a tags-input: typing queries Mapbox (scoped to cities/regions)
 * and shows a suggestion menu. Picking a suggestion — or pressing Enter on a
 * free-typed value — adds it as a chip; the value stored is the canonical name
 * the Lemlist database filter expects (e.g. "Paris"). Multiple selections are
 * OR-ed by the provider's `{ filterId, values }` shape.
 */
export function FilterLocationInput({
  id,
  value,
  onChange,
  scope,
  placeholder,
}: FilterLocationInputProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { suggestions, isSearching, search, clear, resetSession } =
    useLocationSearch({ debounceMs: 250, types: SCOPE_TYPES[scope] });

  const add = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed]);
      setQuery('');
      clear();
      resetSession();
      inputRef.current?.focus();
    },
    [value, onChange, clear, resetSession],
  );

  const remove = useCallback(
    (name: string) => onChange(value.filter((v) => v !== name)),
    [value, onChange],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);
      search(val);
      setOpen(true);
    },
    [search],
  );

  const showPopover = open && (suggestions.length > 0 || isSearching);

  return (
    <Popover open={showPopover} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {/* Tags-input: selected places render as chips inside the field, with
            the search box inline alongside them. */}
        <div
          className={cn(
            'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm',
            'focus-within:outline-none focus-within:ring-1 focus-within:ring-ring',
          )}
          onClick={() => {
            inputRef.current?.focus();
            if (suggestions.length > 0) setOpen(true);
          }}
        >
          {value.map((name) => (
            <Badge key={name} variant="secondary" className="gap-1 rounded-sm pr-1 font-normal">
              {name}
              <Button
                variant="ghost"
                type="button"
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(name);
                }}
                aria-label={t('common.actions.remove')}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
          <input
            ref={inputRef}
            id={id}
            value={query}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              // Enter commits a free-typed value (Lemlist accepts free text).
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault();
                add(query);
              }
              // Backspace on an empty query removes the last chip.
              if (e.key === 'Backspace' && query === '' && value.length > 0) {
                remove(value[value.length - 1]!);
              }
            }}
            onFocus={() => {
              if (suggestions.length > 0) setOpen(true);
            }}
            onBlur={() => {
              // Delay so a click on a suggestion still registers.
              setTimeout(() => setOpen(false), 200);
            }}
            placeholder={value.length === 0 ? placeholder : ''}
            // Suppress the browser's native autofill/suggestion menu and
            // password-manager overlays — this is our own combobox.
            role="combobox"
            aria-expanded={showPopover}
            aria-autocomplete="list"
            autoComplete="new-password"
            name={`welddata-location-${scope}`}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            className="min-w-[80px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="z-[9999] w-(--radix-popover-trigger-width) p-0"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>
              {isSearching
                ? t('welddata.filters.searching')
                : t('welddata.filters.noResults')}
            </CommandEmpty>
            <CommandGroup className="px-1 py-1">
              {suggestions.map((s) => (
                <CommandItem
                  key={s.mapbox_id}
                  value={s.mapbox_id}
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => add(s.name)}
                  className="cursor-pointer"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {s.place_formatted && (
                      <span className="truncate text-xs text-muted-foreground">
                        {s.place_formatted}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
