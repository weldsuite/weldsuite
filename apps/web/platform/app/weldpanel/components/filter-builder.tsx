/**
 * Filters of a query spec: chips for the active ones and a popover form to add
 * one (a column of the visit or page, an event property, a person property or
 * a cohort). `FilterChips` alone serves pages whose filters come from clicking
 * a row.
 */

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  PANEL_FILTER_COLUMNS,
  PANEL_FILTER_OPERATORS,
  type PanelFilter,
  type PanelFilterColumn,
  type PanelFilterOperator,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useWeldPanelCohorts } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { describeFilter, filterKey, isFilterComplete, operatorNeedsValue, parseFilterValue } from '../lib/filters';
import { PropertyPicker } from './pickers';

type FilterSource = PanelFilter['source'];

interface FilterChipsProps {
  filters: readonly PanelFilter[];
  onChange: (filters: PanelFilter[]) => void;
  projectId: string;
  /** Classes for the list; defaults to a wrapping row. */
  className?: string;
}

/** The active filters as removable chips, with a "Clear filters" link from two up. */
export function FilterChips({ filters, onChange, projectId, className }: Readonly<FilterChipsProps>) {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.filters;
  const needsCohorts = filters.some((f) => f.source === 'cohort');
  const { data: cohorts } = useWeldPanelCohorts(projectId, needsCohorts);
  const cohortName = (id: string) => cohorts?.find((c) => c.id === id)?.name;

  if (filters.length === 0) return null;
  return (
    <ul className={className ?? 'flex flex-wrap items-center gap-2'} aria-label={tf.title}>
      {filters.map((filter, index) => {
        const text = describeFilter(filter, tf, cohortName);
        return (
          <li key={filterKey(filter, index)} className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-3 pr-1 text-sm">
            <span className="max-w-64 truncate">{text}</span>
            <button
              type="button"
              className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={tf.remove.replace('{filter}', text)}
              onClick={() => onChange(filters.filter((_, i) => i !== index))}
            >
              <X className="size-3" />
            </button>
          </li>
        );
      })}
      {filters.length > 1 && (
        <li>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
            {tf.clear}
          </Button>
        </li>
      )}
    </ul>
  );
}

interface FilterFormProps {
  projectId: string;
  allowCohort: boolean;
  onAdd: (filter: PanelFilter) => void;
}

function FilterForm({ projectId, allowCohort, onAdd }: Readonly<FilterFormProps>) {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.filters;
  const [source, setSource] = useState<FilterSource>('column');
  const [column, setColumn] = useState<PanelFilterColumn>('path');
  const [key, setKey] = useState('');
  const [operator, setOperator] = useState<PanelFilterOperator>('eq');
  const [text, setText] = useState('');
  const [cohortId, setCohortId] = useState('');
  const [negate, setNegate] = useState(false);
  const { data: cohorts } = useWeldPanelCohorts(projectId, source === 'cohort');

  function build(): PanelFilter {
    if (source === 'cohort') return { source, cohortId, negate };
    const value = parseFilterValue(text, operator);
    if (source === 'column') return { source, field: column, operator, value };
    return { source, key: key.trim(), operator, value };
  }

  const draft = build();
  const complete = isFilterComplete(draft);
  const sources: FilterSource[] = allowCohort ? ['column', 'event', 'person', 'cohort'] : ['column', 'event', 'person'];

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) onAdd(draft);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="weldpanel-filter-source">{tf.source}</Label>
        <Select value={source} onValueChange={(next) => setSource(next as FilterSource)}>
          <SelectTrigger id="weldpanel-filter-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>
                {tf.sources[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {source === 'column' && (
        <div className="grid gap-1.5">
          <Label htmlFor="weldpanel-filter-field">{tf.field}</Label>
          <Select value={column} onValueChange={(next) => setColumn(next as PanelFilterColumn)}>
            <SelectTrigger id="weldpanel-filter-field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PANEL_FILTER_COLUMNS.map((c) => (
                <SelectItem key={c} value={c}>
                  {tf.columns[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {(source === 'event' || source === 'person') && (
        <div className="grid gap-1.5">
          <Label htmlFor="weldpanel-filter-property">{tf.property}</Label>
          <PropertyPicker id="weldpanel-filter-property" projectId={projectId} value={key} onChange={setKey} ariaLabel={tf.property} placeholder={tf.propertyPlaceholder} />
        </div>
      )}

      {source !== 'cohort' ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="weldpanel-filter-operator">{tf.operator}</Label>
            <Select value={operator} onValueChange={(next) => setOperator(next as PanelFilterOperator)}>
              <SelectTrigger id="weldpanel-filter-operator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PANEL_FILTER_OPERATORS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {tf.operators[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {operatorNeedsValue(operator) && (
            <div className="grid gap-1.5">
              <Label htmlFor="weldpanel-filter-value">{tf.value}</Label>
              <Input
                id="weldpanel-filter-value"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={operator === 'in' ? tf.valuesPlaceholder : tf.valuePlaceholder}
                autoComplete="off"
              />
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="weldpanel-filter-cohort-mode">{tf.operator}</Label>
            <Select value={negate ? 'not' : 'in'} onValueChange={(next) => setNegate(next === 'not')}>
              <SelectTrigger id="weldpanel-filter-cohort-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in">{tf.cohortIn}</SelectItem>
                <SelectItem value="not">{tf.cohortNotIn}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="weldpanel-filter-cohort">{tf.cohort}</Label>
            {cohorts && cohorts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tf.noCohorts}</p>
            ) : (
              <Select value={cohortId} onValueChange={setCohortId}>
                <SelectTrigger id="weldpanel-filter-cohort">
                  <SelectValue placeholder={tf.cohortPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {(cohorts ?? []).map((cohort) => (
                    <SelectItem key={cohort.id} value={cohort.id}>
                      {cohort.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </>
      )}

      <Button type="submit" size="sm" disabled={!complete}>
        {tf.apply}
      </Button>
    </form>
  );
}

interface FilterBuilderProps {
  projectId: string;
  filters: readonly PanelFilter[];
  onChange: (filters: PanelFilter[]) => void;
  /** Cohort filters are left out where a cohort may not nest (the cohort editor). */
  allowCohort?: boolean;
  /** Smaller trigger for a series or step row. */
  compact?: boolean;
}

/** Chips plus an "Add filter" popover. */
export function FilterBuilder({ projectId, filters, onChange, allowCohort = true, compact = false }: Readonly<FilterBuilderProps>) {
  const { t } = useI18n();
  const tf = t.weldpanel.analytics.filters;
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterChips filters={filters} onChange={onChange} projectId={projectId} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size={compact ? 'sm' : 'default'} className={compact ? 'h-7 gap-1 px-2 text-xs' : 'h-8 gap-1.5'}>
            <Plus className="size-3.5" />
            {tf.add}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <FilterForm
            projectId={projectId}
            allowCohort={allowCohort}
            onAdd={(filter) => {
              onChange([...filters, filter]);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
