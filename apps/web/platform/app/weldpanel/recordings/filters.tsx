/**
 * The recordings filters: a popover with every filter of the plan, and chips
 * for the ones that are on. All state lives in the URL search, so the parent
 * only passes the search and gets a new one back.
 */

import { useState, type KeyboardEvent } from 'react';
import { ListFilter, X } from 'lucide-react';
import { PANEL_FRUSTRATION_TYPES, type PanelFrustrationType, type RecordingsSearch } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useWeldPanelCohorts } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';
import { EventPicker } from '../components/pickers';
import { activeFilterCount, cleanSearch } from '../lib/recordings-search';

const ANY_COHORT = '__any__';

type Device = NonNullable<RecordingsSearch['devices']>[number];

/** Free-text values added one by one (Enter or the add button), shown as removable chips. */
function TagsField({
  id,
  label,
  hint,
  values,
  placeholder,
  max = 20,
  normalise,
  onChange,
}: Readonly<{ id: string; label: string; hint?: string; values: readonly string[]; placeholder: string; max?: number; normalise?: (v: string) => string; onChange: (next: string[]) => void }>) {
  const { t, format } = useI18n();
  const tf = t.weldpanel.observe.recordings.filters;
  const [draft, setDraft] = useState('');

  function add() {
    const value = (normalise ? normalise(draft) : draft).trim();
    setDraft('');
    if (value === '' || values.includes(value) || values.length >= max) return;
    onChange([...values, value]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  }

  return (
    <LabeledField label={label} htmlFor={id} hint={hint}>
      <div className="flex gap-2">
        <Input id={id} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <Button type="button" variant="outline" size="sm" className="h-9" disabled={draft.trim() === ''} onClick={add}>
          {tf.add}
        </Button>
      </div>
      <ValueChips values={values} remove={(value) => onChange(values.filter((v) => v !== value))} removeLabel={(value) => format(tf.remove, { value })} />
    </LabeledField>
  );
}

function ValueChips({ values, remove, removeLabel }: Readonly<{ values: readonly string[]; remove: (value: string) => void; removeLabel: (value: string) => string }>) {
  if (values.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <li key={value} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs">
          <span className="max-w-48 truncate">{value}</span>
          <button type="button" className="rounded-full p-0.5 hover:bg-accent" aria-label={removeLabel(value)} onClick={() => remove(value)}>
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function EventListField({ projectId, label, values, onChange }: Readonly<{ projectId: string; label: string; values: readonly string[]; onChange: (next: string[]) => void }>) {
  const { t, format } = useI18n();
  const tf = t.weldpanel.observe.recordings.filters;
  return (
    <LabeledField label={label}>
      <EventPicker
        projectId={projectId}
        value=""
        ariaLabel={label}
        placeholder={tf.eventPlaceholder}
        onChange={(name) => {
          if (name && !values.includes(name) && values.length < 10) onChange([...values, name]);
        }}
      />
      <ValueChips values={values} remove={(value) => onChange(values.filter((v) => v !== value))} removeLabel={(value) => format(tf.remove, { value })} />
    </LabeledField>
  );
}

function numberOrUndefined(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

interface RecordingsFiltersProps {
  projectId: string;
  search: RecordingsSearch;
  onChange: (next: RecordingsSearch) => void;
}

export function RecordingsFilters({ projectId, search, onChange }: Readonly<RecordingsFiltersProps>) {
  const { t } = useI18n();
  const tf = t.weldpanel.observe.recordings.filters;
  const { data: cohorts } = useWeldPanelCohorts(projectId);
  const count = activeFilterCount(search);
  const patch = (next: Partial<RecordingsSearch>) => onChange(cleanSearch({ ...search, ...next }));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="h-8 gap-2" aria-label={count > 0 ? tf.active.replace('{count}', String(count)) : tf.button}>
          <ListFilter className="size-4" />
          {count > 0 ? tf.active.replace('{count}', String(count)) : tf.button}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid max-h-[min(80vh,640px)] w-[min(92vw,26rem)] gap-4 overflow-y-auto p-4">
        <p className="text-sm font-medium">{tf.title}</p>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{tf.duration}</legend>
          <div className="grid grid-cols-2 gap-2">
            <LabeledField label={tf.minDuration} htmlFor="weldpanel-rec-min">
              <Input id="weldpanel-rec-min" type="number" min={0} inputMode="numeric" value={search.minDuration ?? ''} onChange={(e) => patch({ minDuration: numberOrUndefined(e.target.value) })} />
            </LabeledField>
            <LabeledField label={tf.maxDuration} htmlFor="weldpanel-rec-max">
              <Input id="weldpanel-rec-max" type="number" min={0} inputMode="numeric" value={search.maxDuration ?? ''} onChange={(e) => patch({ maxDuration: numberOrUndefined(e.target.value) })} />
            </LabeledField>
          </div>
        </fieldset>

        <TagsField id="weldpanel-rec-pages" label={tf.pagesVisited} hint={tf.pagesVisitedHint} placeholder={tf.pagePlaceholder} values={search.pages ?? []} onChange={(pages) => patch({ pages })} />
        <div className="grid grid-cols-2 gap-2">
          <LabeledField label={tf.entryPage} htmlFor="weldpanel-rec-entry">
            <Input id="weldpanel-rec-entry" value={search.entryPage ?? ''} placeholder={tf.pagePlaceholder} onChange={(e) => patch({ entryPage: e.target.value || undefined })} />
          </LabeledField>
          <LabeledField label={tf.exitPage} htmlFor="weldpanel-rec-exit">
            <Input id="weldpanel-rec-exit" value={search.exitPage ?? ''} placeholder={tf.pagePlaceholder} onChange={(e) => patch({ exitPage: e.target.value || undefined })} />
          </LabeledField>
        </div>

        <LabeledField label={tf.devices}>
          <ToggleGroup type="multiple" variant="outline" size="sm" value={search.devices ?? []} onValueChange={(devices) => patch({ devices: devices as Device[] })} aria-label={tf.devices}>
            {(['desktop', 'tablet', 'mobile'] as const).map((device) => (
              <ToggleGroupItem key={device} value={device}>
                {t.weldpanel.observe.common.devices[device]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </LabeledField>

        <TagsField
          id="weldpanel-rec-countries"
          label={tf.countries}
          hint={tf.countriesHint}
          placeholder={tf.countryPlaceholder}
          values={search.countries ?? []}
          normalise={(v) => v.trim().toUpperCase()}
          onChange={(countries) => patch({ countries })}
        />
        <TagsField id="weldpanel-rec-browsers" label={tf.browsers} placeholder={tf.browserPlaceholder} values={search.browsers ?? []} onChange={(browsers) => patch({ browsers })} />

        <LabeledField label={tf.user} htmlFor="weldpanel-rec-user">
          <Input id="weldpanel-rec-user" value={search.user ?? ''} placeholder={tf.userPlaceholder} onChange={(e) => patch({ user: e.target.value.trim() || undefined })} />
        </LabeledField>

        {cohorts && cohorts.length > 0 && (
          <LabeledField label={tf.cohort} htmlFor="weldpanel-rec-cohort">
            <Select value={search.cohort ?? ANY_COHORT} onValueChange={(value) => patch({ cohort: value === ANY_COHORT ? undefined : value })}>
              <SelectTrigger id="weldpanel-rec-cohort" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_COHORT}>{tf.anyCohort}</SelectItem>
                {cohorts.map((cohort) => (
                  <SelectItem key={cohort.id} value={cohort.id}>
                    {cohort.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabeledField>
        )}

        <EventListField projectId={projectId} label={tf.did} values={search.did ?? []} onChange={(did) => patch({ did })} />
        <EventListField projectId={projectId} label={tf.didNot} values={search.didNot ?? []} onChange={(didNot) => patch({ didNot })} />

        <LabeledField label={tf.frustration}>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            className="flex-wrap"
            value={search.frustration ?? []}
            onValueChange={(frustration) => patch({ frustration: frustration as PanelFrustrationType[] })}
            aria-label={tf.frustration}
          >
            {PANEL_FRUSTRATION_TYPES.map((type) => (
              <ToggleGroupItem key={type} value={type}>
                {tf.frustrationTypes[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </LabeledField>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="weldpanel-rec-errors" className="font-normal">
            {tf.errors}
          </Label>
          <Switch id="weldpanel-rec-errors" checked={search.errors === true} onCheckedChange={(checked) => patch({ errors: checked || undefined })} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="weldpanel-rec-favorites" className="font-normal">
            {tf.favorites}
          </Label>
          <Switch id="weldpanel-rec-favorites" checked={search.favorites === true} onCheckedChange={(checked) => patch({ favorites: checked || undefined })} />
        </div>

        {count > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() =>
              onChange(
                cleanSearch({
                  project: search.project,
                  range: search.range,
                  from: search.from,
                  to: search.to,
                  sort: search.sort,
                }),
              )
            }
          >
            {tf.clear}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
