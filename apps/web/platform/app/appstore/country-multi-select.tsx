import { useId, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Popover, PopoverAnchor, PopoverContent } from '@weldsuite/ui/components/popover';
import { useTranslations } from '@weldsuite/i18n/client';
import { COUNTRIES } from '@/lib/constants/countries';
import { useReachFormat } from '@/lib/reach/format';
import { cn } from '@/lib/utils';

interface CountryMultiSelectProps {
  id?: string;
  /** Selected ISO 3166-1 alpha-2 codes. */
  value: string[];
  onChange: (codes: string[]) => void;
  placeholder: string;
  invalid?: boolean;
}

interface CountryOption {
  code: string;
  name: string;
}

/**
 * Searchable multi-select over the platform's ISO country list. Values are the
 * two-letter codes the access request stores; names are shown in the UI
 * language (Intl.DisplayNames), falling back to the English list.
 */
export function CountryMultiSelect({ id, value, onChange, placeholder, invalid }: Readonly<CountryMultiSelectProps>) {
  const t = useTranslations();
  const { locale } = useReachFormat();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const options = useMemo<CountryOption[]>(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return COUNTRIES.map((country) => ({
      code: country.code,
      name: names?.of(country.code) ?? country.name,
    })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);

  const nameOf = (code: string) => options.find((option) => option.code === code)?.name ?? code;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.name.toLowerCase().includes(q) || option.code.toLowerCase() === q);
  }, [options, query]);

  const toggle = (code: string) => {
    onChange(value.includes(code) ? value.filter((v) => v !== code) : [...value, code]);
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          role="presentation"
          aria-invalid={invalid || undefined}
          className={cn(
            'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm',
            'focus-within:outline-none focus-within:ring-1 focus-within:ring-ring',
            invalid && 'border-destructive',
          )}
          onClick={() => {
            inputRef.current?.focus();
            setOpen(true);
          }}
        >
          {value.map((code) => (
            <Badge key={code} variant="secondary" className="gap-1 rounded-sm pr-1 font-normal">
              {nameOf(code)}
              <Button
                variant="ghost"
                type="button"
                className="h-auto rounded-sm p-0 text-muted-foreground transition-colors hover:text-foreground"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(code);
                }}
                aria-label={t('reach.accessUi.removeCountry', { country: nameOf(code) })}
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
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              // Backspace on an empty query removes the last chip.
              if (e.key === 'Backspace' && query === '' && value.length > 0) onChange(value.slice(0, -1));
            }}
            onBlur={() => {
              // Delay so a click on a menu item still registers.
              setTimeout(() => setOpen(false), 200);
            }}
            placeholder={value.length === 0 ? placeholder : t('reach.accessUi.countrySearch')}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            // Chrome reads a field about countries as an address and offers
            // autofill over our own menu; "new-password" is the token it respects.
            autoComplete="new-password"
            name="reach-access-country-search"
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
        id={listboxId}
        className="z-[9999] w-(--radix-popover-trigger-width) p-0"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>{t('reach.accessUi.countryNone')}</CommandEmpty>
            <CommandGroup className="px-1 py-1">
              {matches.map((option) => {
                const selected = value.includes(option.code);
                return (
                  <CommandItem
                    key={option.code}
                    value={option.name}
                    onMouseDown={(e) => e.preventDefault()}
                    onSelect={() => toggle(option.code)}
                    className={cn('cursor-pointer', selected && 'bg-muted')}
                  >
                    {option.name}
                    <Check className={cn('ml-auto h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
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
