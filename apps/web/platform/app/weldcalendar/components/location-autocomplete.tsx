import { useState, useRef, useCallback } from 'react';
import { MapPin, Globe, Building2, Map } from 'lucide-react';
import { cn } from '@/lib/utils';
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
  onSuggestionSelect?: (suggestion: MapboxSuggestion) => void;
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
}

function getIconForType(featureType?: string) {
  switch (featureType) {
    case 'country':
      return Globe;
    case 'region':
      return Map;
    case 'poi':
      return Building2;
    default:
      return MapPin;
  }
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
}: LocationAutocompleteProps) {
  const t = getTranslations('weldcalendar');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { suggestions, isSearching, search, clear, resetSession } =
    useLocationSearch();

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
      onSuggestionSelect?.(suggestion);
      setOpen(false);
      clear();
      resetSession();
    },
    [onChange, onSuggestionSelect, clear, resetSession],
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
            }}
            onFocus={() => {
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
                    {s.place_formatted && (
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
