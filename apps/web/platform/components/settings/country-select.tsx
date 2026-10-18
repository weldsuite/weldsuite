import { useMemo, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useI18n } from '@/lib/i18n/provider';
import { COUNTRIES } from '@/lib/constants/countries';
import { cn } from '@/lib/utils';

export interface CountryOption {
  code: string;
  name: string;
}

/**
 * Every country in `COUNTRIES`, named in the UI language (Intl.DisplayNames,
 * falling back to the English name) and sorted by that name.
 */
export function localizedCountries(language: string): CountryOption[] {
  let displayNames: Intl.DisplayNames | null = null;
  try {
    displayNames = new Intl.DisplayNames([language], { type: 'region' });
  } catch {
    displayNames = null;
  }
  return COUNTRIES.map((country) => {
    let name = country.name;
    try {
      name = displayNames?.of(country.code) || country.name;
    } catch {
      // An unknown region code keeps its English name.
    }
    return { code: country.code, name };
  }).sort((a, b) => a.name.localeCompare(b.name, language));
}

type TriggerProps = Omit<ComponentPropsWithoutRef<typeof Button>, 'value' | 'onChange' | 'children'>;

export interface CountrySelectProps extends TriggerProps {
  /** ISO 3166 alpha-2 code, or '' for none. */
  value: string | null | undefined;
  onChange: (code: string) => void;
  placeholder?: string;
}

/**
 * Searchable country picker (ISO alpha-2 codes) shared by Business settings and
 * the Billing details dialog, so both offer the same full list. Extra props
 * (`id`, `aria-invalid`, `aria-describedby`, ... as a shadcn `FormControl`
 * passes them) land on the trigger button.
 */
export function CountrySelect({ value, onChange, placeholder, className, disabled, ...triggerProps }: Readonly<CountrySelectProps>) {
  const { language, t } = useI18n();
  const st = useTranslations();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const countries = useMemo(() => localizedCountries(language), [language]);
  const selected = countries.find((country) => country.code === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !selected && 'text-muted-foreground', className)}
          {...triggerProps}
        >
          <span className="truncate">{selected ? selected.name : placeholder ?? t.settings.generalSettings.selectCountry}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onOpenAutoFocus={() => {
          // Scroll the current country into view instead of opening at "A".
          requestAnimationFrame(() => {
            const list = listRef.current;
            const item = list?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
            if (!list || !item) return;
            const offset = item.offsetTop - list.clientHeight * 0.6 + item.clientHeight / 2;
            list.scrollTop = Math.max(0, offset);
          });
        }}
      >
        <Command defaultValue={selected ? `${selected.name} ${selected.code}` : undefined}>
          <CommandInput placeholder={st('sweep.settings.business.searchCountryPlaceholder')} />
          <CommandList
            ref={listRef}
            className="max-h-[240px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted-foreground/20 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent"
          >
            <CommandEmpty>{st('sweep.settings.business.noCountryFound')}</CommandEmpty>
            <CommandGroup className="pr-0">
              {countries.map((country) => {
                const isCurrent = value === country.code;
                return (
                  <CommandItem
                    key={country.code}
                    value={`${country.name} ${country.code}`}
                    onSelect={() => {
                      onChange(country.code);
                      setOpen(false);
                    }}
                    className={cn('flex justify-between', isCurrent && 'bg-accent text-accent-foreground')}
                  >
                    {country.name}
                    <Check className={cn('h-4 w-4', isCurrent ? 'opacity-100' : 'opacity-0')} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
