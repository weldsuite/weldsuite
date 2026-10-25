import { createContext, useContext, useState } from 'react';
import { Table } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import type { DocController } from './model/doc-controller';
import { insertTableAtCaret } from './model/table-actions';
import { BUTTON, WithTooltip } from './ui';

const MAX = 10;

/** Closes the menu a picker sits in (the grid's squares are not menu items, so picking one does not close it). */
export const CloseMenuContext = createContext<() => void>(() => undefined);

/** The grid of squares for picking a new table's size, as in Google Docs. */
export function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const close = useContext(CloseMenuContext);
  const [hover, setHover] = useState({ rows: 1, cols: 1 });
  return (
    <div className="flex flex-col gap-1 p-1" onMouseLeave={() => setHover({ rows: 1, cols: 1 })}>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${MAX}, 1rem)` }}>
        {Array.from({ length: MAX * MAX }, (_, i) => {
          const r = Math.floor(i / MAX) + 1;
          const c = (i % MAX) + 1;
          const on = r <= hover.rows && c <= hover.cols;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r} × ${c}`}
              className={`size-4 rounded-[2px] border ${on ? 'border-blue-500 bg-blue-500/20' : 'border-border bg-background'}`}
              onMouseEnter={() => setHover({ rows: r, cols: c })}
              onFocus={() => setHover({ rows: r, cols: c })}
              onClick={() => {
                onPick(r, c);
                close();
              }}
            />
          );
        })}
      </div>
      <span className="text-center text-xs text-muted-foreground">
        {hover.cols} × {hover.rows}
      </span>
    </div>
  );
}

/** The toolbar's table button: the size grid in a drop-down. */
export function TableButton({ controller, label, disabled }: { controller: DocController; label: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <WithTooltip label={label}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button type="button" className={BUTTON} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            <Table />
          </button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        <CloseMenuContext.Provider value={() => setOpen(false)}>
          <TablePicker onPick={(rows, cols) => insertTableAtCaret(controller, rows, cols)} />
        </CloseMenuContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
