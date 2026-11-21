/**
 * Event and property pickers fed by the project's lexicon. Hidden names leave
 * the list, but a name already chosen stays shown, and a name that isn't in
 * the list can still be typed when it is valid (a new event nobody sent yet,
 * or the lexicon failing to load).
 *
 * Inside a `PanelDefinitionsProvider` the event picker also lists the
 * project's custom events (`@pnce_…`) and, where a spec takes an event
 * property, the property picker its computed properties (`@pncp_…`), each
 * shown by name. `AggregateByPicker` is the "count by" choice (people, or one
 * group type).
 */

import { useMemo, useState } from 'react';
import { Calculator, Check, ChevronsUpDown, Layers } from 'lucide-react';
import {
  PANEL_PAGEVIEW,
  PANEL_WEBVITALS,
  panelEventNameSchema,
  panelPropertyKeySchema,
  type PanelAggregateBy,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { cn } from '@weldsuite/ui/lib/utils';
import { useWeldPanelLexicon } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { formatNumber } from '../lib/format';
import { usePanelDefinitions } from './definitions';

/** `$` events the SDK sends on its own: always offered, even before the lexicon has seen them. */
export const BUILT_IN_EVENTS = [
  PANEL_PAGEVIEW,
  '$pageleave',
  '$autocapture',
  '$rageclick',
  '$deadclick',
  '$quickback',
  '$excessivescroll',
  '$exception',
  PANEL_WEBVITALS,
] as const;

export type NameOptionGroup = 'builtIn' | 'customEvents' | 'custom' | 'computed' | 'properties';

const GROUP_ORDER: readonly NameOptionGroup[] = ['customEvents', 'builtIn', 'custom', 'computed', 'properties'];

export interface NameOption {
  /** What goes in the spec: a name, or a definition's `@…` ref. */
  name: string;
  /** What is shown, when it differs from `name` (a custom event's or computed property's name). */
  label?: string;
  group: NameOptionGroup;
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

function GroupIcon({ group }: Readonly<{ group: NameOptionGroup }>) {
  if (group === 'customEvents') return <Layers className="size-3.5 shrink-0 text-primary" aria-hidden />;
  if (group === 'computed') return <Calculator className="size-3.5 shrink-0 text-primary" aria-hidden />;
  return null;
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
  const tx = t.weldpanel.explore.pickers;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const groupLabel: Record<NameOptionGroup, string> = {
    builtIn: tp.groupBuiltIn,
    custom: tp.groupCustom,
    properties: tp.groupProperties,
    customEvents: tx.groupCustomEvents,
    computed: tx.groupComputed,
  };
  const trimmed = search.trim();
  const canUseTyped = trimmed !== '' && !options.some((o) => o.name === trimmed) && isValidName(trimmed);
  const selected = options.find((o) => o.name === value);

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
          <span className="flex min-w-0 items-center gap-1.5">
            {selected && <GroupIcon group={selected.group} />}
            <span className="truncate">{selected?.label ?? (value || placeholder)}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-64 p-0" align="start">
        <Command>
          <CommandInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {GROUP_ORDER.map((group) => {
              const items = options.filter((o) => o.group === group);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={group} heading={groupLabel[group]}>
                  {items.map((option) => (
                    <CommandItem key={option.name} value={option.label ? `${option.label} ${option.name}` : option.name} onSelect={() => pick(option.name)}>
                      <Check className={cn('size-4', option.name === value ? 'opacity-100' : 'opacity-0')} />
                      <GroupIcon group={option.group} />
                      <span className="min-w-0 flex-1 truncate">
                        {option.label ?? option.name}
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

/**
 * The events of a project: custom events (inside a definitions provider),
 * built-in ones, then what the lexicon has seen (verified and busy first).
 */
export function useEventOptions(projectId: string, selected: string, allowCustomEvents = true): NameOption[] {
  const { data } = useWeldPanelLexicon(projectId);
  const definitions = usePanelDefinitions();
  return useMemo(() => {
    const options: NameOption[] = [];
    if (allowCustomEvents) {
      for (const e of definitions.customEvents) options.push({ name: e.ref, label: e.name, group: 'customEvents', description: e.description });
    }
    const seen = (data?.events ?? []).filter((e) => !e.hidden || e.name === selected);
    const byName = new Map(seen.map((e) => [e.name, e]));
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
    if (selected && !options.some((o) => o.name === selected)) {
      let group: NameOptionGroup = 'custom';
      if (selected.startsWith('@')) group = 'customEvents';
      else if (selected.startsWith('$')) group = 'builtIn';
      options.push({ name: selected, group });
    }
    return options;
  }, [data, selected, definitions.customEvents, allowCustomEvents]);
}

/** Properties from the lexicon, with the project's computed properties first when `includeComputed`. */
export function usePropertyOptions(projectId: string, selected: string, includeComputed = false): NameOption[] {
  const { data } = useWeldPanelLexicon(projectId);
  const definitions = usePanelDefinitions();
  return useMemo(() => {
    const options: NameOption[] = includeComputed
      ? definitions.computedProperties.map((p) => ({ name: p.ref, label: p.name, group: 'computed' as const, description: p.description }))
      : [];
    for (const p of [...(data?.properties ?? [])].filter((p) => !p.hidden || p.name === selected).sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name))) {
      options.push({ name: p.name, group: 'properties', description: p.description, verified: p.verified });
    }
    if (selected && !options.some((o) => o.name === selected)) options.push({ name: selected, group: selected.startsWith('@') ? 'computed' : 'properties' });
    return options;
  }, [data, selected, definitions.computedProperties, includeComputed]);
}

interface EventPickerProps extends PickerProps {
  /** Offer the project's custom events (when a definitions provider is mounted). Off where a spec takes plain names only. */
  allowCustomEvents?: boolean;
}

export function EventPicker({ projectId, value, onChange, ariaLabel, id, placeholder, disabled, className, allowCustomEvents = true }: Readonly<EventPickerProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.analytics.pickers;
  const options = useEventOptions(projectId, value, allowCustomEvents);
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

interface PropertyPickerProps extends PickerProps {
  /** An event property: computed properties may be picked too (inside a definitions provider). */
  includeComputed?: boolean;
}

export function PropertyPicker({ projectId, value, onChange, ariaLabel, id, placeholder, disabled, className, includeComputed = false }: Readonly<PropertyPickerProps>) {
  const { t } = useI18n();
  const tp = t.weldpanel.analytics.pickers;
  const options = usePropertyOptions(projectId, value, includeComputed);
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

const PERSON = 'person';
const GROUP_PREFIX = 'group:';

interface AggregateByPickerProps {
  value: PanelAggregateBy | undefined;
  onChange: (value: PanelAggregateBy | undefined) => void;
  id?: string;
  className?: string;
}

/**
 * "Count by": people (the default, left out of the spec) or one group type.
 * Renders nothing until the project has a group type, unless a saved spec
 * already counts groups.
 */
export function AggregateByPicker({ value, onChange, id, className }: Readonly<AggregateByPickerProps>) {
  const { t } = useI18n();
  const tx = t.weldpanel.explore.countBy;
  const { groupTypes } = usePanelDefinitions();
  const current = value && value !== 'person' ? value.groupType : null;
  if (groupTypes.length === 0 && current === null) return null;
  const types = groupTypes.map((g) => ({ value: g.groupType, label: g.namePlural }));
  if (current && !types.some((g) => g.value === current)) types.push({ value: current, label: current });

  return (
    <Select
      value={current ? `${GROUP_PREFIX}${current}` : PERSON}
      onValueChange={(next) => onChange(next === PERSON ? undefined : { groupType: next.slice(GROUP_PREFIX.length) })}
    >
      <SelectTrigger id={id} className={className} aria-label={tx.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PERSON}>{tx.people}</SelectItem>
        {types.map((g) => (
          <SelectItem key={g.value} value={`${GROUP_PREFIX}${g.value}`}>
            {g.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Whether the "count by" control has anything to offer (so a page can leave out its label too). */
export function useHasGroupTypes(value?: PanelAggregateBy): boolean {
  const { groupTypes } = usePanelDefinitions();
  return groupTypes.length > 0 || (value !== undefined && value !== 'person');
}
