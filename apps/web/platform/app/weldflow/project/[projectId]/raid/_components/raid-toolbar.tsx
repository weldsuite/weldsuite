import { ChevronDown, Plus, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import type { RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { categoryLabel, statusLabel } from '../_lib/copy';
import { ALL, EMPTY_FILTERS, NO_OWNER, hasActiveFilters, type RegisterFilters } from '../_lib/raid';
import { useRaid } from './raid-context';

interface FilterMenuProps {
  label: string;
  /** The current value; `ALL` shows no value in the button. */
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

/** A dashed filter button that opens a single-choice list. */
function FilterMenu({ label, value, options, onChange }: Readonly<FilterMenuProps>) {
  const selected = options.find((option) => option.value === value);
  const active = value !== ALL;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('border-dashed font-normal', active && 'border-solid border-foreground/40 bg-accent/50')}
        >
          {label}
          {active && selected ? <span className="font-medium">: {selected.label}</span> : null}
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-44 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface RaidToolbarProps {
  kind: RaidKind;
  filters: RegisterFilters;
  onFiltersChange: (filters: RegisterFilters) => void;
  statuses: readonly string[];
  /** User ids that own at least one item shown, and whether some item has no owner. */
  ownerIds: string[];
  hasUnowned: boolean;
  /** Categories in use; omitted for kinds without a category. */
  categories?: string[];
  /** Number of closed items; omit `onToggleClosed` for a kind that shows them all the time. */
  closedCount: number;
  showClosed: boolean;
  onToggleClosed?: () => void;
}

/** Search, filters, the closed toggle and the "New ..." button of one register. */
export function RaidToolbar({
  kind,
  filters,
  onFiltersChange,
  statuses,
  ownerIds,
  hasUnowned,
  categories,
  closedCount,
  showClosed,
  onToggleClosed,
}: Readonly<RaidToolbarProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const { memberOf, abilities, openCreate } = useRaid();
  const set = (patch: Partial<RegisterFilters>) => onFiltersChange({ ...filters, ...patch });

  const statusOptions = [
    { value: ALL, label: copy.toolbar.all },
    ...statuses.map((status) => ({ value: status, label: statusLabel(copy, kind, status) })),
  ];
  const ownerOptions = [
    { value: ALL, label: copy.toolbar.all },
    ...(hasUnowned ? [{ value: NO_OWNER, label: copy.toolbar.unassigned }] : []),
    ...ownerIds.map((id) => ({ value: id, label: memberOf(id)?.name ?? copy.register.unknownOwner })),
  ];
  const categoryOptions = [
    { value: ALL, label: copy.toolbar.all },
    ...(categories ?? []).map((category) => ({ value: category, label: categoryLabel(copy, category) ?? category })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative min-w-40 flex-[0_1_16rem]">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={filters.search}
          onChange={(event) => set({ search: event.target.value })}
          placeholder={copy.toolbar.search[kind]}
          aria-label={copy.toolbar.search[kind]}
          className="h-8 pl-8 text-[13px]"
        />
      </div>
      <FilterMenu label={copy.toolbar.status} value={filters.status} options={statusOptions} onChange={(status) => set({ status })} />
      <FilterMenu label={copy.toolbar.owner} value={filters.ownerId} options={ownerOptions} onChange={(ownerId) => set({ ownerId })} />
      {categories && categories.length > 0 ? (
        <FilterMenu label={copy.toolbar.category} value={filters.category} options={categoryOptions} onChange={(category) => set({ category })} />
      ) : null}
      {hasActiveFilters(filters) ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onFiltersChange(EMPTY_FILTERS)}>
          {copy.toolbar.clearFilters}
        </Button>
      ) : null}

      <div className="min-w-0 flex-1" />

      {onToggleClosed && closedCount > 0 ? (
        <Button type="button" variant="outline" size="sm" aria-pressed={showClosed} onClick={onToggleClosed}>
          {format(showClosed ? copy.toolbar.hideClosed : copy.toolbar.showClosed, { count: closedCount })}
        </Button>
      ) : null}
      {abilities.create ? (
        <Button type="button" size="sm" onClick={() => openCreate(kind)}>
          <Plus aria-hidden />
          {copy.newItem[kind]}
        </Button>
      ) : null}
    </div>
  );
}
