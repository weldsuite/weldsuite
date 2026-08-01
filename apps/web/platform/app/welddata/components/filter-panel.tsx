import { useMemo } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useWelddataLists } from '@/hooks/queries/use-welddata-queries';
import type { WelddataFilterDef } from '../lib/filters-catalog';
import { FilterLocationInput } from './filter-location-input';
import { FilterCountrySelect } from './filter-country-select';

export type FilterValues = Record<string, string[]>;

type Kind = 'person' | 'company';

interface FilterPanelProps {
  definitions: WelddataFilterDef[];
  values: FilterValues;
  onChange: (filterId: string, values: string[]) => void;
  onClear: () => void;
  kind: Kind;
  onKindChange: (kind: Kind) => void;
  /** WeldData list ids whose already-saved leads are excluded from results. */
  excludeListIds: string[];
  onExcludeListIdsChange: (ids: string[]) => void;
}

const ANY = '__any';

/**
 * Renders the hard-coded WeldData filter catalog (see lib/filters-catalog).
 * Each filter gets a human label and the input affordance that matches its
 * type — free text, a number range, or a single select with the provider's
 * exact option list.
 *
 * Values are stored as a `string[]` per filterId so the search payload mirrors
 * the provider's `{ filterId, values }` shape:
 *   - text / select → `[value]`
 *   - range         → `[min, max]` (either side may be '')
 * An empty array means "not applied" and is dropped before searching.
 */
export function FilterPanel({
  definitions,
  values,
  onChange,
  onClear,
  kind,
  onKindChange,
  excludeListIds,
  onExcludeListIdsChange,
}: FilterPanelProps) {
  const t = useTranslations();
  const hasActive =
    Object.values(values).some((v) => v.length > 0) || excludeListIds.length > 0;

  // Lists of the current kind — selecting one hides its already-saved leads
  // from the results (a person list can only exclude person searches).
  const { data: listsResp } = useWelddataLists();
  const excludableLists = useMemo(
    () => (listsResp?.data ?? []).filter((l) => l.kind === kind),
    [listsResp, kind],
  );

  const toggleExcludeList = (id: string, checked: boolean) => {
    onExcludeListIdsChange(
      checked ? [...excludeListIds, id] : excludeListIds.filter((x) => x !== id),
    );
  };

  return (
    <div className="space-y-4">
      <Tabs value={kind} onValueChange={(v) => onKindChange(v as Kind)}>
        <TabsList className="w-full">
          <TabsTrigger value="person" className="flex-1">
            {t('welddata.search.people')}
          </TabsTrigger>
          <TabsTrigger value="company" className="flex-1">
            {t('welddata.search.companies')}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Fixed height (matches the h-7 clear button) so the row doesn't grow —
          and shift the filters below — when "Clear filters" appears. */}
      <div className="flex h-7 items-center justify-between">
        <h3 className="text-sm font-medium">{t('welddata.search.filters')}</h3>
        {hasActive && (
          <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
            {t('welddata.search.clearFilters')}
          </Button>
        )}
      </div>

      {/* Exclude leads already saved in the chosen lists. The provider can't do
          this (lists live in our DB), so it's applied server-side. */}
      {excludableLists.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-dashed p-3">
          <Label className="text-xs font-medium" title={t('welddata.search.excludeListsHint')}>
            {t('welddata.search.excludeListsLabel')}
          </Label>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('welddata.search.excludeListsHint')}
          </p>
          <div className="space-y-1.5 pt-1">
            {excludableLists.map((list) => {
              const checkboxId = `exclude-list-${list.id}`;
              return (
                <label
                  key={list.id}
                  htmlFor={checkboxId}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={checkboxId}
                    checked={excludeListIds.includes(list.id)}
                    onCheckedChange={(v) => toggleExcludeList(list.id, v === true)}
                  />
                  <span className={`h-2.5 w-2.5 shrink-0 rounded ${list.color}`} />
                  <span className="min-w-0 truncate">{list.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {definitions.map((def) => {
        const current = values[def.filterId] ?? [];
        const inputId = `filter-${def.filterId}`;
        return (
          <div key={def.filterId} className="space-y-1.5">
            <Label htmlFor={inputId} className="text-xs font-medium" title={def.description}>
              {def.label}
            </Label>
            <FilterControl
              def={def}
              inputId={inputId}
              current={current}
              onChange={(next) => onChange(def.filterId, next)}
              t={t}
            />
          </div>
        );
      })}
    </div>
  );
}

interface FilterControlProps {
  def: WelddataFilterDef;
  inputId: string;
  current: string[];
  onChange: (values: string[]) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

function FilterControl({ def, inputId, current, onChange, t }: FilterControlProps) {
  // Country fields are a multi-select of the full country list — pick one or
  // more countries to apply (values are OR-ed by the provider).
  if (def.location === 'country') {
    return (
      <FilterCountrySelect
        id={inputId}
        value={current}
        placeholder={def.placeholder ?? def.label}
        onChange={onChange}
      />
    );
  }

  // City/state fields are a Mapbox-backed multi-select (no finite list) — pick
  // one or more places to apply.
  if (def.location) {
    return (
      <FilterLocationInput
        id={inputId}
        scope={def.location}
        value={current}
        placeholder={def.placeholder ?? def.label}
        onChange={onChange}
      />
    );
  }

  switch (def.inputType) {
    case 'number':
      return (
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          value={current[0] ?? ''}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        />
      );

    case 'range': {
      // Stored as a single "min|max" string (Lemlist's slider value format).
      const [min = '', max = ''] = (current[0] ?? '').split('|');
      const commit = (nextMin: string, nextMax: string) => {
        if (!nextMin && !nextMax) {
          onChange([]);
          return;
        }
        // Lemlist sliders are always bounded, so fill an empty side with the
        // filter's min/max bound to form a valid "from|to" range.
        const lo = nextMin || (def.range ? String(def.range.min) : '');
        const hi = nextMax || (def.range ? String(def.range.max) : '');
        onChange([`${lo}|${hi}`]);
      };
      const minPlaceholder = def.range ? String(def.range.min) : t('welddata.filters.min');
      const maxPlaceholder = def.range
        ? `${def.range.max}${def.range.percentage ? '%' : ''}`
        : t('welddata.filters.max');
      return (
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            value={min}
            placeholder={minPlaceholder}
            min={def.range?.min}
            max={def.range?.max}
            onChange={(e) => commit(e.target.value, max)}
          />
          <span className="text-xs text-muted-foreground">{t('welddata.filters.to')}</span>
          <Input
            type="number"
            inputMode="numeric"
            value={max}
            placeholder={maxPlaceholder}
            min={def.range?.min}
            max={def.range?.max}
            onChange={(e) => commit(min, e.target.value)}
          />
        </div>
      );
    }

    case 'select':
      return (
        <Select
          value={current[0] ?? ANY}
          onValueChange={(v) => onChange(v === ANY ? [] : [v])}
        >
          <SelectTrigger id={inputId} className="w-full">
            <SelectValue placeholder={t('welddata.filters.any')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('welddata.filters.any')}</SelectItem>
            {(def.options ?? []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case 'text':
    default:
      return (
        <Input
          id={inputId}
          value={current[0] ?? ''}
          placeholder={def.placeholder ?? def.label}
          onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        />
      );
  }
}
