import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowDownAZ, ArrowUpZA, Plus, X } from 'lucide-react';
import { PIVOT_FUNCTIONS, refText, type PivotFunction, type PivotGroup, type PivotSpec, type PivotTable } from '@weldsuite/sheets-engine';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { parseDataRange, rangeLabel } from '../model/charts';
import { fieldValues, pivotFields, savePivot } from '../model/pivots';
import type { SheetController } from '../model/sheet-controller';
import { CommitInput, Field } from '../rules/fields';
import { RulePanel } from '../rules/panel';

/** The pivot table editor: the table the active cell is in, rewritten on every change. */
export function PivotPanel({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const tp = t.weldsheets.pivot;
  const table = controller.pivot;
  return (
    <RulePanel title={tp.editor} closeLabel={tp.close} onClose={() => controller.openPanel(null)}>
      {table ? <PivotForm controller={controller} table={table} /> : <p className="text-sm text-muted-foreground">{tp.pickTable}</p>}
    </RulePanel>
  );
}

function PivotForm({ controller, table }: { controller: SheetController; table: PivotTable }) {
  const { t } = useI18n();
  const tp = t.weldsheets.pivot;
  const spec = table.spec;
  const fields = table.source ? pivotFields(controller, table.source) : [];
  const save = (next: Partial<PivotSpec>) => savePivot(controller, table, { ...spec, ...next });

  const setSource = (text: string) => {
    const at = parseDataRange(controller, text);
    if (!at) {
      toast.error(tp.sourceInvalid);
      return;
    }
    save({ source: refText(controller.engine, at) });
  };

  const groups = (key: 'rows' | 'columns', label: string) => {
    const list = spec[key];
    const set = (next: PivotGroup[]) => save(key === 'rows' ? { rows: next } : { columns: next });
    return (
      <Section label={label} fields={fields} addLabel={tp.add} onAdd={(field) => set([...list, { field }])}>
        {list.map((g, i) => (
          <GroupRow
            key={`${i}:${g.field}`}
            group={g}
            onChange={(next) => set(list.map((x, j) => (j === i ? next : x)))}
            onRemove={() => set(list.filter((_, j) => j !== i))}
          />
        ))}
      </Section>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Field label={tp.source}>
        <CommitInput label={tp.source} value={table.source ? rangeLabel(controller, table.source) : ''} onCommit={setSource} mono />
      </Field>
      {!table.source && <p className="text-sm text-destructive">{tp.sourceMissing}</p>}
      {groups('rows', tp.rows)}
      {groups('columns', tp.columns)}
      <Section label={tp.values} fields={fields} addLabel={tp.add} onAdd={(field) => save({ values: [...spec.values, { field, fn: 'SUM' }] })}>
        {spec.values.map((v, i) => (
          <FieldRow key={`${i}:${v.field}`} field={v.field} removeLabel={tp.remove} onRemove={() => save({ values: spec.values.filter((_, j) => j !== i) })}>
            <Select value={v.fn} onValueChange={(fn) => save({ values: spec.values.map((x, j) => (j === i ? { ...x, fn: fn as PivotFunction } : x)) })}>
              <SelectTrigger className="h-7 w-32 text-xs" aria-label={tp.summarizeBy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PIVOT_FUNCTIONS.map((fn) => (
                  <SelectItem key={fn} value={fn}>
                    {tp.functions[fn]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        ))}
      </Section>
      <Section
        label={tp.filters}
        fields={fields.filter((f) => !spec.filters.some((x) => x.field.toLowerCase() === f.toLowerCase()))}
        addLabel={tp.add}
        onAdd={(field) => table.source && save({ filters: [...spec.filters, { field, values: fieldValues(controller, table.source, field) }] })}
      >
        {spec.filters.map((f, i) => (
          <FieldRow key={f.field} field={f.field} removeLabel={tp.remove} onRemove={() => save({ filters: spec.filters.filter((_, j) => j !== i) })}>
            {table.source && (
              <FilterValues
                all={fieldValues(controller, table.source, f.field)}
                shown={f.values}
                onChange={(values) => save({ filters: spec.filters.map((x, j) => (j === i ? { ...x, values } : x)) })}
              />
            )}
          </FieldRow>
        ))}
      </Section>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={spec.totals} onCheckedChange={(v) => save({ totals: v === true })} />
        {tp.showTotals}
      </label>
    </div>
  );
}

/** A titled list of fields with an "Add" menu of the source's fields. */
function Section({
  label,
  fields,
  addLabel,
  onAdd,
  children,
}: {
  label: string;
  fields: string[];
  addLabel: string;
  onAdd: (field: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent disabled:opacity-40 [&_svg]:size-3.5"
              disabled={fields.length === 0}
              aria-label={`${addLabel}: ${label}`}
            >
              <Plus />
              {addLabel}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            {fields.map((f) => (
              <DropdownMenuItem key={f} onSelect={() => onAdd(f)}>
                {f}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function FieldRow({ field, removeLabel, onRemove, children }: { field: string; removeLabel: string; onRemove: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1">
      <span className="min-w-0 flex-1 truncate text-sm">{field}</span>
      {children}
      <button type="button" className="rounded p-0.5 hover:bg-accent [&_svg]:size-3.5" aria-label={`${removeLabel}: ${field}`} title={removeLabel} onClick={onRemove}>
        <X />
      </button>
    </div>
  );
}

function GroupRow({ group, onChange, onRemove }: { group: PivotGroup; onChange: (g: PivotGroup) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const tp = t.weldsheets.pivot;
  const order = group.descending ? tp.descending : tp.ascending;
  const toggle = () => onChange(group.descending ? { field: group.field } : { field: group.field, descending: true });
  return (
    <FieldRow field={group.field} removeLabel={tp.remove} onRemove={onRemove}>
      <button type="button" className="flex items-center gap-1 rounded px-1 text-xs hover:bg-accent [&_svg]:size-3.5" onClick={toggle} title={order} aria-label={`${group.field}: ${order}`}>
        {group.descending ? <ArrowUpZA /> : <ArrowDownAZ />}
      </button>
    </FieldRow>
  );
}

/** Which values of a filter field show: a checklist in a popover. */
function FilterValues({ all, shown, onChange }: { all: string[]; shown: string[]; onChange: (values: string[]) => void }) {
  const { t, format } = useI18n();
  const tp = t.weldsheets.pivot;
  const [open, setOpen] = useState(false);
  const isShown = (v: string) => shown.some((s) => s.toLowerCase() === v.toLowerCase());
  const count = all.filter(isShown).length;
  const toggle = (v: string, on: boolean) => onChange(on ? [...shown, v] : shown.filter((s) => s.toLowerCase() !== v.toLowerCase()));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="rounded border bg-background px-1.5 py-0.5 text-xs hover:bg-accent">
          {count === all.length ? tp.allShown : format(tp.someShown, { count, total: all.length })}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <div className="mb-2 flex gap-2 text-xs">
          <button type="button" className="text-primary hover:underline" onClick={() => onChange(all)}>
            {tp.selectAll}
          </button>
          <button type="button" className="text-primary hover:underline" onClick={() => onChange([])}>
            {tp.clear}
          </button>
        </div>
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
          {all.map((v) => (
            <li key={v}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={isShown(v)} onCheckedChange={(on) => toggle(v, on === true)} />
                <span className="truncate">{v === '' ? tp.blank : v}</span>
              </label>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
