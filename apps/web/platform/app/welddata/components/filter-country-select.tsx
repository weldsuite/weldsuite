import { useMemo, useRef, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Check, X } from 'lucide-react';
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
import { COUNTRIES } from '@/lib/constants/countries';

interface FilterCountrySelectProps {
  id: string;
  /** Currently applied country names (provider sends these verbatim). */
  value: string[];
  /** Fires with the full selected list (empty array = not applied). */
  onChange: (values: string[]) => void;
  placeholder?: string;
}

/**
 * Multi-select for country filters. The field itself is a search box: typing
 * filters the full ISO country list shown in the menu below. Picking a country
 * adds it (values are the country *names*, which the lead database expects);
 * multiple selections are OR-ed by the provider's `{ filterId, values }` shape.
 */
export function FilterCountrySelect({
  id,
  value,
  onChange,
  placeholder,
}: FilterCountrySelectProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) => c.name.toLowerCase().includes(q));
  }, [query]);

  const toggle = (name: string) => {
    onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          {/* Tags-input: selected countries render as chips inside the field,
              with the search box inline alongside them. */}
          <div
            className={cn(
              'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm',
              'focus-within:outline-none focus-within:ring-1 focus-within:ring-ring',
            )}
            onClick={() => {
              inputRef.current?.focus();
              setOpen(true);
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
                    toggle(name);
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
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                // Backspace on an empty query removes the last chip.
                if (e.key === 'Backspace' && query === '' && value.length > 0) {
                  onChange(value.slice(0, -1));
                }
              }}
              onBlur={() => {
                // Delay so a click on a menu item still registers.
                setTimeout(() => setOpen(false), 200);
              }}
              placeholder={value.length === 0 ? placeholder ?? t('welddata.filters.searchCountries') : ''}
              // Suppress the browser's native autofill/suggestion menu (Chrome's
              // address heuristics fire on the "country" id/label otherwise) and
              // password-manager overlays — this is our own combobox.
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              // Chrome ignores autoComplete="off" for fields it reads as an
              // address "country" (from the id/label); "new-password" is the
              // reliable token that suppresses its address-autofill dropdown.
              autoComplete="new-password"
              name="welddata-country-search"
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
              <CommandEmpty>{t('welddata.filters.noCountries')}</CommandEmpty>
              <CommandGroup className="px-1 py-1">
                {matches.map((c) => {
                  const selected = value.includes(c.name);
                  return (
                    <CommandItem
                      key={c.code}
                      value={c.name}
                      onMouseDown={(e) => e.preventDefault()}
                      onSelect={() => toggle(c.name)}
                      className={cn('cursor-pointer', selected && 'bg-muted')}
                    >
                      {c.name}
                      <Check className={cn('ml-auto h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
