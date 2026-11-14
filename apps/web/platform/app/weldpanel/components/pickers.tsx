/**
 * Event and property pickers fed by the project's lexicon. Hidden names leave
 * the list, but a name already chosen stays shown, and a name that isn't in
 * the list can still be typed when it is valid (a new event nobody sent yet,
 * or the lexicon failing to load).
 */

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { PANEL_PAGEVIEW, panelEventNameSchema, panelPropertyKeySchema } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@weldsuite/ui/lib/utils';
import { useWeldPanelLexicon } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber } from '../lib/format';

/** `$` events the SDK sends on its own: always offered, even before the lexicon has seen them. */
export const BUILT_IN_EVENTS = [PANEL_PAGEVIEW, '$pageleave', '$autocapture', '$rageclick', '$deadclick', '$quickback', '$excessivescroll', '$exception'] as const;

export interface NameOption {
  name: string;
  group: 'builtIn' | 'custom' | 'properties';
  description?: string | null;
  verified?: boolean;
  count?: number | null;
}

interface NamePickerProps {
  value: string;
  onChange: (name: string) => void;
  options: NameOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Whether a typed name that isn't in the list may be used. */
  isValidName: (name: string) => boolean;
  ariaLabel: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function NamePicker({
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  isValidName,
  ariaLabel,
  id,
  disabled,
  className,
}: Readonly<NamePickerProps>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.analytics.pickers;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const groupLabel: Record<NameOption['group'], string> = { builtIn: tp.groupBuiltIn, custom: tp.groupCustom, properties: tp.groupProperties };
  const trimmed = search.trim();
  const canUseTyped = trimmed !== '' && !options.some((o) => o.name === trimmed) && isValidName(trimmed);

  function pick(name: string) {
    onChange(name);
    setOpen(false);
    setSearch('');
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('h-9 w-full min-w-0 justify-between font-normal', !value && 'text-muted-foreground', className)}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-64 p-0" align="start">
        <Command>
          <CommandInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {(['builtIn', 'custom', 'properties'] as const).map((group) => {
              const items = options.filter((o) => o.group === group);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={group} heading={groupLabel[group]}>
                  {items.map((option) => (
                    <CommandItem key={option.name} value={option.name} onSelect={() => pick(option.name)}>
                      <Check className={cn('size-4', option.name === value ? 'opacity-100' : 'opacity-0')} />
                      <span className="min-w-0 flex-1 truncate">
                        {option.name}
                        {option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}
                      </span>
                      {option.verified && <span className="text-xs text-emerald-600 dark:text-emerald-400">{tp.verified}</span>}
                      {typeof option.count === 'number' && option.count > 0 && (
                        <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(option.count, language)}</span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
            {canUseTyped && (
              <CommandGroup forceMount>
                <CommandItem forceMount value={`__use__${trimmed}`} onSelect={() => pick(trimmed)}>
                  {tp.useName.replace('{name}', trimmed)}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const isEventName = (name: string) => panelEventNameSchema.safeParse(name).success;
const isPropertyName = (name: string) => panelPropertyKeySchema.safeParse(name).success;

interface PickerProps {
  projectId: string;
  value: string;
  onChange: (name: string) => void;
  ariaLabel?: string;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/** The events of a project: built-in ones, then what the lexicon has seen (verified and busy first). */
export function useEventOptions(projectId: string, selected: string): NameOption[] {
  const { data } = useWeldPanelLexicon(projectId);
  return useMemo(() => {
    const seen = (data?.events ?? []).filter((e) => !e.hidden || e.name === selected);
    const byName = new Map(seen.map((e) => [e.name, e]));
    const options: NameOption[] = [];
    for (const name of BUILT_IN_EVENTS) {
      const entry = byName.get(name);
      if (entry?.hidden && name !== selected) continue;
      options.push({ name, group: 'builtIn', description: entry?.description, verified: entry?.verified, count: entry?.count30d });
      byName.delete(name);
    }
    const custom = [...byName.values()]
      .filter((e) => !e.name.startsWith('$'))
      .sort((a, b) => Number(b.verified) - Number(a.verified) || (b.count30d ?? 0) - (a.count30d ?? 0) || a.name.localeCompare(b.name));
    for (const e of custom) options.push({ name: e.name, group: 'custom', description: e.description, verified: e.verified, count: e.count30d });
    if (selected && !options.some((o) => o.name === selected)) options.push({ name: selected, group: selected.startsWith('$') ? 'builtIn' : 'custom' });
    return options;
  }, [data, selected]);
}

export function usePropertyOptions(projectId: string, selected: string): NameOption[] {
  const { data } = useWeldPanelLexicon(projectId);
  return useMemo(() => {
    const options: NameOption[] = (data?.properties ?? [])
      .filter((p) => !p.hidden || p.name === selected)
      .sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, group: 'properties', description: p.description, verified: p.verified }));
    if (selected && !options.some((o) => o.name === selected)) options.push({ name: selected, group: 'properties' });
    return options;
  }, [data, selected]);
}

export function EventPicker({ projectId, value, onChange, ariaLabel, id, placeholder, disabled, className }: Readonly<PickerProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.analytics.pickers;
  const options = useEventOptions(projectId, value);
  return (
    <NamePicker
      id={id}
      className={className}
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder ?? tp.eventPlaceholder}
      searchPlaceholder={tp.eventSearch}
      emptyText={tp.eventEmpty}
      isValidName={isEventName}
      ariaLabel={ariaLabel ?? tp.eventPlaceholder}
    />
  );
}

export function PropertyPicker({ projectId, value, onChange, ariaLabel, id, placeholder, disabled, className }: Readonly<PickerProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.analytics.pickers;
  const options = usePropertyOptions(projectId, value);
  return (
    <NamePicker
      id={id}
      className={className}
      disabled={disabled}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder ?? tp.propertyPlaceholder}
      searchPlaceholder={tp.propertySearch}
      emptyText={tp.propertyEmpty}
      isValidName={isPropertyName}
      ariaLabel={ariaLabel ?? tp.propertyPlaceholder}
    />
  );
}
