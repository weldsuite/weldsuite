import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { listOptions } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverAnchor, PopoverContent } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import type { Rect } from '../grid/geometry';
import type { SheetController } from '../model/sheet-controller';
import { filterValues, setFilterColumn, sortByColumn } from '../model/rules';
import { fromDraft, toDraft } from './conditions';
import { ConditionFields } from './fields';

/** Values listed at most in the filter menu; the search box reaches the rest. */
const MAX_VALUES = 500;

/** A popover pinned to a cell of the grid: under its right edge (filter button) or its left edge (dropdown). */
function CellPopover({
  rect,
  onClose,
  className,
  align = 'end',
  children,
}: {
  rect: Rect;
  onClose: () => void;
  className: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <div className="pointer-events-none absolute" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
      </PopoverAnchor>
      <PopoverContent align={align} className={className} onCloseAutoFocus={(e) => e.preventDefault()}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

const MENU_ITEM = 'w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent';

/** The menu of a filter column: sort, filter by condition, filter by values. */
export function FilterMenu({ controller, col, rect, onClose }: { controller: SheetController; col: number; rect: Rect; onClose: () => void }) {
  const { t, format } = useI18n();
  const tf = t.weldsheets.filterMenu;
  const td = t.weldsheets.data;
  const locale = controller.options.formulaLocale;
  const column = controller.sheet.filter?.columns.find((c) => c.col === col);
  const [draft, setDraft] = useState(() => toDraft(column?.condition, locale));
  const [hidden, setHidden] = useState(() => new Set(column?.hiddenValues ?? []));
  const [search, setSearch] = useState('');
  const values = useMemo(() => filterValues(controller, col), [controller, col]);
  const label = (key: string, text: string) => (key === '' ? tf.blanks : text);
  const needle = search.trim().toLowerCase();
  const matching = needle ? values.filter((v) => label(v.key, v.label).toLowerCase().includes(needle)) : values;
  const shown = matching.slice(0, MAX_VALUES);

  const sort = (descending: boolean) => {
    const problem = sortByColumn(controller, col, descending);
    if (problem) toast.error(problem === 'merged' ? td.sortMerged : td.sortNothing);
    onClose();
  };

  const toggle = (key: string, visible: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = () => {
    const condition = fromDraft(draft, locale);
    if (condition === null) {
      toast.error(tf.invalid);
      return;
    }
    setFilterColumn(controller, col, { hiddenValues: [...hidden], ...(condition && { condition }) });
    onClose();
  };

  return (
    <CellPopover rect={rect} onClose={onClose} className="w-72 p-0">
      <div className="border-b p-1">
        <button type="button" className={MENU_ITEM} onClick={() => sort(false)}>
          {td.sortAsc}
        </button>
        <button type="button" className={MENU_ITEM} onClick={() => sort(true)}>
          {td.sortDesc}
        </button>
      </div>
      <div className="flex flex-col gap-2 border-b p-3">
        <span className="text-xs font-medium text-muted-foreground">{tf.byCondition}</span>
        <ConditionFields draft={draft} onChange={setDraft} />
      </div>
      <div className="flex flex-col gap-2 p-3">
        <span className="text-xs font-medium text-muted-foreground">{tf.byValues}</span>
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-primary hover:underline" onClick={() => setHidden(new Set())}>
            {tf.selectAll}
          </button>
          <button type="button" className="text-primary hover:underline" onClick={() => setHidden(new Set(values.map((v) => v.key)))}>
            {tf.clear}
          </button>
        </div>
        <Input className="h-8 text-sm" placeholder={tf.search} aria-label={tf.search} value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-52 overflow-y-auto pr-1">
          {shown.map((v) => (
            // A label around the checkbox makes the whole row clickable.
            <label key={v.key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
              <Checkbox checked={!hidden.has(v.key)} onCheckedChange={(on) => toggle(v.key, on === true)} />
              <span className="min-w-0 flex-1 truncate">{label(v.key, v.label)}</span>
              <span className="text-xs text-muted-foreground">{v.count}</span>
            </label>
          ))}
        </div>
        {matching.length > MAX_VALUES && <p className="text-xs text-muted-foreground">{format(tf.showingFirst, { count: MAX_VALUES })}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t p-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {tf.cancel}
        </Button>
        <Button size="sm" onClick={apply}>
          {tf.ok}
        </Button>
      </div>
    </CellPopover>
  );
}

/** The choices of a dropdown cell (data validation list). */
export function ListMenu({ controller, row, col, rect, onClose }: { controller: SheetController; row: number; col: number; rect: Rect; onClose: () => void }) {
  const rule = controller.validationAt(row, col);
  const options = rule ? listOptions(controller.engine, controller.activeSheetId, rule) : [];
  const current = controller.inputText(row, col).toLowerCase();
  const choose = (option: string) => {
    controller.setInput(row, col, option);
    onClose();
  };
  return (
    <CellPopover rect={rect} onClose={onClose} align="start" className="max-h-72 w-56 overflow-y-auto p-1">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`${MENU_ITEM} ${option.toLowerCase() === current ? 'bg-accent font-medium' : ''}`}
          onClick={() => choose(option)}
        >
          {option}
        </button>
      ))}
    </CellPopover>
  );
}
