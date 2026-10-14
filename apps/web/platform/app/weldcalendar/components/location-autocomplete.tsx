import { useState, useRef, useCallback } from 'react';
import { getTranslations } from '@/lib/i18n';
import { Input } from '@weldsuite/ui/components/input';
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

interface LocationAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * A suggestion was picked. `sessionToken` is the search session it came
   * from, for a `retrieveLocation` of its full details.
   */
  onSuggestionSelect?: (suggestion: MapboxSuggestion, sessionToken: string) => void;
  /** Mapbox feature types to search (e.g. `'place'`, `'address,poi'`); defaults to all of them. */
  searchTypes?: string;
  /** Restrict results to one country (ISO 3166-1 alpha-2). */
  country?: string;
  /** List suggestions by name only, without the region/country line under it. */
  hidePlaceDetails?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  id?: string;
  disabled?: boolean;
  /** Vertical offset from the anchor, in px. Defaults to 4. */
  popoverSideOffset?: number;
  /** Horizontal offset relative to the anchor's start edge, in px. Defaults to 0. */
  popoverAlignOffset?: number;
  /** Fires when the underlying input loses focus (after the suggestion-click grace period). */
  onBlurAfterGrace?: () => void;
  /** Runs after the built-in key handling (Escape closes the suggestions). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Select the whole value when the input gains focus, like a grid cell editor. */
  selectOnFocus?: boolean;
}

function formatDisplay(s: MapboxSuggestion): string {
  if (s.feature_type === 'country') return s.name;
  return s.place_formatted ? `${s.name}, ${s.place_formatted}` : s.name;
}

export function LocationAutocomplete({
  value,
  onChange,
  onSuggestionSelect,
  placeholder,
  className,
  autoFocus,
  id,
  disabled,
  popoverSideOffset = 4,
  popoverAlignOffset = 0,
  onBlurAfterGrace,
  onKeyDown,
  selectOnFocus,
  searchTypes,
  country,
  hidePlaceDetails,
}: Readonly<LocationAutocompleteProps>) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { suggestions, isSearching, search, clear, resetSession, getSessionToken } =
    useLocationSearch({ types: searchTypes, country: country?.toLowerCase() || undefined });

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      onChange(val);
      search(val);
      setOpen(true);
    },
    [onChange, search],
  );

  const handleSelect = useCallback(
    (suggestion: MapboxSuggestion) => {
      onChange(formatDisplay(suggestion));
      onSuggestionSelect?.(suggestion, getSessionToken());
      setOpen(false);
      clear();
      resetSession();
    },
    [onChange, onSuggestionSelect, clear, resetSession, getSessionToken],
  );

  const showPopover = open && (suggestions.length > 0 || isSearching);

  return (
    <Popover open={showPopover} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            ref={inputRef}
            id={id}
            value={value}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              onKeyDown?.(e);
            }}
            onFocus={(e) => {
              if (selectOnFocus) e.currentTarget.select();
              if (suggestions.length > 0) setOpen(true);
            }}
            onBlur={() => {
              // Delay to allow click on suggestion
              setTimeout(() => {
                setOpen(false);
                onBlurAfterGrace?.();
              }, 200);
            }}
            placeholder={placeholder ?? t.locationAutocomplete.addLocation}
            className={className}
            autoFocus={autoFocus}
            disabled={disabled}
            autoComplete="off"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="z-[9999] p-0 w-[315px]"
        align="start"
        sideOffset={popoverSideOffset}
        alignOffset={popoverAlignOffset}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>
              {isSearching ? t.locationAutocomplete.searching : t.locationAutocomplete.noResults}
            </CommandEmpty>
            <CommandGroup className="px-1 py-1">
              {suggestions.map((s) => (
                <CommandItem
                  key={s.mapbox_id}
                  value={s.mapbox_id}
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() => handleSelect(s)}
                  className="cursor-pointer"
                >
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-medium truncate">{s.name}</span>
                    {s.place_formatted && !hidePlaceDetails && (
                      <span className="text-xs text-muted-foreground truncate">
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
