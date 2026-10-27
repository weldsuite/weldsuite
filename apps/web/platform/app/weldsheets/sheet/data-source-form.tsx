import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  findSheetDataField,
  sheetDataOpNeedsValue,
  MAX_SHEET_DATA_COLUMNS,
  MAX_SHEET_DATA_FILTERS,
  MAX_SHEET_DATA_ROWS,
  SHEET_DATA_FILTER_OPS_BY_TYPE,
  SHEET_DATA_OBJECTS,
  type SheetDataObjectKey,
} from '@weldsuite/app-api-client/schemas/sheet-data';
import { SHEET_DATA_REFRESH, type SheetDataRefresh } from '@weldsuite/app-api-client/schemas/sheets';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { draftIsValid, moveColumn, newFilter, refield, type FieldLabel, type FilterDraft, type SourceDraft } from './data-source-draft';

/** Sort value for "newest first" (no sort field). */
const NEWEST = '__newest';

/** A field's name in the viewer's language (the field key when it has none). */
export function useFieldLabel(): FieldLabel {
  const { t } = useI18n();
  return (objectType, field) => (t.sheetData.fields[objectType] as Record<string, string> | undefined)?.[field] ?? field;
}

/**
 * What a connected table lists: the object (fixed once connected), the fields
 * as columns under their titles, filters, order, how many records, and when
 * it refreshes by itself.
 */
export function DataSourceForm({
  draft,
  onChange,
  objects,
  onObjectChange,
  at,
  saving,
  onSave,
  onCancel,
}: {
  draft: SourceDraft;
  onChange: (draft: SourceDraft) => void;
  /** Objects the viewer may list; empty: the object cannot change (an existing table). */
  objects: SheetDataObjectKey[];
  onObjectChange: (objectType: SheetDataObjectKey) => void;
  /** The new tab a new table goes on ("Companies"); unset for an existing one. */
  at?: string;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  const label = useFieldLabel();
  const fields = SHEET_DATA_OBJECTS[draft.objectType].fields;
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border bg-card p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (draftIsValid(draft)) onSave();
      }}
    >
      <Labelled text={td.object}>
        <Select value={draft.objectType} disabled={objects.length === 0} onValueChange={(v) => onObjectChange(v as SheetDataObjectKey)}>
          <SelectTrigger className="h-8 w-full text-sm" aria-label={td.object}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(objects.length ? objects : [draft.objectType]).map((key) => (
              <SelectItem key={key} value={key}>
                {t.sheetData.objects[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Labelled>

      <ColumnsEditor draft={draft} onChange={onChange} label={label} />
      <FiltersEditor draft={draft} onChange={onChange} label={label} />

      <Labelled text={td.sort}>
        <div className="flex gap-2">
          <Select
            value={draft.sort?.field ?? NEWEST}
            onValueChange={(v) => onChange({ ...draft, sort: v === NEWEST ? null : { field: v, descending: draft.sort?.descending ?? false } })}
          >
            <SelectTrigger className="h-8 min-w-0 flex-1 text-sm" aria-label={td.sort}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEWEST}>{td.newestFirst}</SelectItem>
              {fields.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {label(draft.objectType, f.key)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draft.sort && (
            <Select value={draft.sort.descending ? 'desc' : 'asc'} onValueChange={(v) => draft.sort && onChange({ ...draft, sort: { ...draft.sort, descending: v === 'desc' } })}>
              <SelectTrigger className="h-8 w-32 text-sm" aria-label={td.direction}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">{td.ascending}</SelectItem>
                <SelectItem value="desc">{td.descending}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </Labelled>

      <div className="flex gap-2">
        <Labelled text={td.limit} className="flex-1">
          <Input
            className="h-8 text-sm"
            type="number"
            min={1}
            max={MAX_SHEET_DATA_ROWS}
            value={draft.limit}
            onChange={(e) => onChange({ ...draft, limit: e.target.value })}
            aria-label={td.limit}
          />
        </Labelled>
        <Labelled text={td.refresh} className="flex-1">
          <Select value={draft.refresh} onValueChange={(v) => onChange({ ...draft, refresh: v as SheetDataRefresh })}>
            <SelectTrigger className="h-8 w-full text-sm" aria-label={td.refresh}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHEET_DATA_REFRESH.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {td.refreshModes[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Labelled>
      </div>

      {at && <p className="text-xs text-muted-foreground">{td.at.replace('{name}', at)}</p>}
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          {td.cancel}
        </Button>
        <Button type="submit" size="sm" className="h-7" disabled={saving || !draftIsValid(draft)}>
          {at ? td.connect : td.save}
        </Button>
      </div>
    </form>
  );
}

function Labelled({ text, className = '', children }: { text: string; className?: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-muted-foreground">{text}</span>
      {children}
    </div>
  );
}

/** The fields shown, in order, each under a title the viewer can change. */
function ColumnsEditor({ draft, onChange, label }: { draft: SourceDraft; onChange: (draft: SourceDraft) => void; label: FieldLabel }) {
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  const used = new Set(draft.columns.map((c) => c.field));
  const rest = SHEET_DATA_OBJECTS[draft.objectType].fields.filter((f) => !used.has(f.key));
  const set = (columns: SourceDraft['columns']) => onChange({ ...draft, columns });
  return (
    <Labelled text={td.columns}>
      {draft.columns.map((column, i) => (
        <div key={column.field} className="flex items-center gap-1">
          <Input
            className="h-8 min-w-0 flex-1 text-sm"
            value={column.header}
            maxLength={255}
            title={label(draft.objectType, column.field)}
            aria-label={td.header.replace('{field}', label(draft.objectType, column.field))}
            onChange={(e) => set(draft.columns.map((c, j) => (j === i ? { ...c, header: e.target.value } : c)))}
          />
          <IconButton label={td.moveUp} disabled={i === 0} onClick={() => set(moveColumn(draft.columns, i, -1))}>
            <ArrowUp />
          </IconButton>
          <IconButton label={td.moveDown} disabled={i === draft.columns.length - 1} onClick={() => set(moveColumn(draft.columns, i, 1))}>
            <ArrowDown />
          </IconButton>
          <IconButton label={td.remove} disabled={draft.columns.length === 1} onClick={() => set(draft.columns.filter((_, j) => j !== i))}>
            <X />
          </IconButton>
        </div>
      ))}
      {rest.length > 0 && draft.columns.length < MAX_SHEET_DATA_COLUMNS && (
        <Select value="" onValueChange={(field) => set([...draft.columns, { field, header: label(draft.objectType, field) }])}>
          <SelectTrigger className="h-8 w-full text-sm text-muted-foreground" aria-label={td.addColumn}>
            <SelectValue placeholder={td.addColumn} />
          </SelectTrigger>
          <SelectContent>
            {rest.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {label(draft.objectType, f.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Labelled>
  );
}

/** Which records: every filter must match. */
function FiltersEditor({ draft, onChange, label }: { draft: SourceDraft; onChange: (draft: SourceDraft) => void; label: FieldLabel }) {
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  const fields = SHEET_DATA_OBJECTS[draft.objectType].fields;
  const set = (filters: FilterDraft[]) => onChange({ ...draft, filters });
  return (
    <Labelled text={td.filters}>
      {draft.filters.map((filter, i) => (
        <FilterRow
          // Filters have no ids; a row is its place in the list.
          key={`${i}-${filter.field}`}
          objectType={draft.objectType}
          filter={filter}
          label={label}
          onChange={(next) => set(draft.filters.map((f, j) => (j === i ? next : f)))}
          onRemove={() => set(draft.filters.filter((_, j) => j !== i))}
        />
      ))}
      {draft.filters.length < MAX_SHEET_DATA_FILTERS && (
        <Select value="" onValueChange={(field) => set([...draft.filters, newFilter(draft.objectType, field)])}>
          <SelectTrigger className="h-8 w-full text-sm text-muted-foreground" aria-label={td.addFilter}>
            <SelectValue placeholder={td.addFilter} />
          </SelectTrigger>
          <SelectContent>
            {fields.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {label(draft.objectType, f.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Labelled>
  );
}

function FilterRow({
  objectType,
  filter,
  label,
  onChange,
  onRemove,
}: {
  objectType: SheetDataObjectKey;
  filter: FilterDraft;
  label: FieldLabel;
  onChange: (filter: FilterDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  const type = findSheetDataField(objectType, filter.field)?.type ?? 'text';
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2">
      <div className="flex items-center gap-1">
        <Select value={filter.field} onValueChange={(field) => onChange(refield(objectType, filter, field))}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-sm" aria-label={td.field}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHEET_DATA_OBJECTS[objectType].fields.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {label(objectType, f.key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <IconButton label={td.remove} onClick={onRemove}>
          <X />
        </IconButton>
      </div>
      <Select value={filter.op} onValueChange={(op) => onChange({ ...filter, op: op as FilterDraft['op'] })}>
        <SelectTrigger className="h-8 w-full text-sm" aria-label={td.operator}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SHEET_DATA_FILTER_OPS_BY_TYPE[type].map((op) => (
            <SelectItem key={op} value={op}>
              {td.ops[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {sheetDataOpNeedsValue(filter.op) && <FilterValue type={type} value={filter.value} onChange={(value) => onChange({ ...filter, value })} />}
    </div>
  );
}

function FilterValue({ type, value, onChange }: { type: string; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  if (type === 'boolean') {
    return (
      <Select value={value || 'true'} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-full text-sm" aria-label={td.value}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">{td.yes}</SelectItem>
          <SelectItem value="false">{td.no}</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  const date = type === 'date' || type === 'datetime';
  const number = type === 'number' || type === 'currency';
  return (
    <Input
      className="h-8 text-sm"
      type={date ? 'date' : 'text'}
      inputMode={number ? 'decimal' : undefined}
      value={value}
      placeholder={td.value}
      aria-label={td.value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
