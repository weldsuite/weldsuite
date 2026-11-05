import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { findOnBoard } from '@weldsuite/board-engine';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardController } from './model/board-controller';

/**
 * Find on the board (Ctrl/Cmd+F): every element whose text holds what was
 * typed, in reading order. Enter goes to the next one, Shift+Enter back; the
 * match is selected and brought into view.
 */
export function FindBar({ controller: c, onClose }: { controller: BoardController; onClose: () => void }) {
  const version = useSyncExternalStore(c.subscribe, c.getVersion);
  const { t, format } = useI18n();
  const tf = t.weldboard.editor.find;
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // The board changes while the bar is open: look again on every version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => findOnBoard(c.board, query), [c, query, version]);
  const current = matches.length ? Math.min(index, matches.length - 1) : -1;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const go = (to: number) => {
    if (!matches.length) return;
    const next = (to + matches.length) % matches.length;
    setIndex(next);
    const el = c.board.get(matches[next]!);
    if (!el) return;
    c.select([el.id]);
    c.showRect(c.boundsOf(el), { maxZoom: 1.5, margin: 120 });
  };

  return (
    <div role="search" className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-background px-2 py-1 shadow-md">
      <Search className="size-4 text-muted-foreground" aria-hidden="true" />
      <input
        ref={input}
        value={query}
        aria-label={tf.label}
        placeholder={tf.placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            // The first Enter shows the current match; the next ones move on.
            const shown = current >= 0 && c.selection.has(matches[current]!);
            go(e.shiftKey ? current - 1 : shown ? current + 1 : Math.max(current, 0));
          }
          if (e.key === 'Escape') onClose();
        }}
        className="h-7 w-48 bg-transparent px-1 text-sm outline-none"
      />
      <span className="min-w-[4.5rem] text-right text-xs tabular-nums text-muted-foreground" aria-live="polite">
        {query.trim() ? (matches.length ? format(tf.count, { current: current + 1, total: matches.length }) : tf.none) : ''}
      </span>
      <Button size="icon" variant="ghost" className="size-7" aria-label={tf.previous} disabled={!matches.length} onClick={() => go(current - 1)}>
        <ChevronUp className="size-4" />
      </Button>
      <Button size="icon" variant="ghost" className="size-7" aria-label={tf.next} disabled={!matches.length} onClick={() => go(current + 1)}>
        <ChevronDown className="size-4" />
      </Button>
      <Button size="icon" variant="ghost" className="size-7" aria-label={tf.close} onClick={onClose}>
        <X className="size-4" />
      </Button>
    </div>
  );
}
