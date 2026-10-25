import { useState } from 'react';

const MAX = 10;

/** The grid of squares for picking a new table's size, as in Google Docs. */
export function TablePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
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
              onClick={() => onPick(r, c)}
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
