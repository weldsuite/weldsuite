import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { colToLetters, type SortKey } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from '../model/sheet-controller';
import { currentRegion, sortRange } from '../model/rules';
import { clampToGrid, primaryRange } from '../model/selection';
import { parseRanges, rangesText } from './conditions';

/** "Sort range": the selection (or its current region), by one or more columns. */
export function SortDialog({ controller, onClose }: { controller: SheetController; onClose: () => void }) {
  const { t, format } = useI18n();
  const ts = t.weldsheets.sortDialog;
  const td = t.weldsheets.data;
  const [initial] = useState(() => {
    const sheet = controller.sheet;
    const sel = clampToGrid(primaryRange(controller.selection), sheet.rowCount, sheet.colCount);
    return sel.r1 === sel.r2 && sel.c1 === sel.c2 ? currentRegion(controller, sel.r1, sel.c1) : sel;
  });
  const [rangeText, setRangeText] = useState(rangesText([initial]));
  const [header, setHeader] = useState(initial.r1 < controller.sheet.freeze.rows);
  const [keys, setKeys] = useState<SortKey[]>([{ col: Math.max(initial.c1, Math.min(controller.selection.active.col, initial.c2)) }]);
  const range = parseRanges(rangeText)?.[0] ?? null;
  const columns = range ? Array.from({ length: range.c2 - range.c1 + 1 }, (_, i) => range.c1 + i) : [];

  const columnLabel = (col: number) => {
    const name = header && range ? controller.displayText(range.r1, col).text : '';
    return name || format(ts.column, { col: colToLetters(col) });
  };
  const setKey = (i: number, patch: Partial<SortKey>) => setKeys((ks) => ks.map((k, j) => (j === i ? { ...k, ...patch } : k)));

  const sort = () => {
    if (!range) {
      toast.error(t.weldsheets.conditionalFormats.rangeInvalid);
      return;
    }
    const valid = keys.filter((k) => k.col >= range.c1 && k.col <= range.c2);
    const problem = sortRange(controller, range, valid, header);
    if (problem) {
      toast.error(problem === 'merged' ? td.sortMerged : td.sortNothing);
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
            {ts.range}
            <Input className="h-8 font-mono text-sm text-foreground" value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={header} onCheckedChange={(on) => setHeader(on === true)} />
            {ts.header}
          </label>
          {keys.map((key, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{i === 0 ? ts.sortBy : ts.thenBy}</span>
              <Select value={String(key.col)} onValueChange={(v) => setKey(i, { col: Number(v) })}>
                <SelectTrigger className="h-8 min-w-0 flex-1 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((col) => (
                    <SelectItem key={col} value={String(col)}>
                      {columnLabel(col)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={key.descending ? 'desc' : 'asc'} onValueChange={(v) => setKey(i, { descending: v === 'desc' })}>
                <SelectTrigger className="h-8 w-24 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">{ts.ascending}</SelectItem>
                  <SelectItem value="desc">{ts.descending}</SelectItem>
                </SelectContent>
              </Select>
              {i > 0 && (
                <button type="button" className="rounded p-1 hover:bg-accent" aria-label={ts.removeColumn} onClick={() => setKeys((ks) => ks.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </button>
              )}
            </div>
          ))}
          {range && keys.length < columns.length && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setKeys((ks) => [...ks, { col: columns.find((c) => !ks.some((k) => k.col === c)) ?? range.c1 }])}
            >
              <Plus />
              {ts.addColumn}
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {ts.cancel}
          </Button>
          <Button onClick={sort}>{ts.sort}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
