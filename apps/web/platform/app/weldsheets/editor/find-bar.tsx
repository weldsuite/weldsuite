import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Replace, Settings2, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import { findMatches, replaceMatches, type FindMatch, type FindOptions } from './model/find';
import type { SheetController } from './model/sheet-controller';

const DEFAULT_OPTIONS: FindOptions = { matchCase: false, wholeCell: false, formulas: false, allSheets: false };

/**
 * Find (Ctrl+F) and replace (Ctrl+H), floating over the top right of the
 * grid: Enter goes to the next match, Shift+Enter to the previous one,
 * Escape closes. A match is shown by selecting its cell.
 */
export function FindBar({ controller }: { controller: SheetController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t, format } = useI18n();
  const tf = t.weldsheets.find;
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [opts, setOpts] = useState<FindOptions>(DEFAULT_OPTIONS);
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const replacing = controller.find === 'replace' && !controller.readOnly;
  const revision = controller.contentRevision;
  const activeSheet = controller.activeSheetId;

  const matches = useMemo(
    () => findMatches(controller, query, opts),
    // Searched again when the cells change, or the sheet does (the active sheet is searched first).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [controller, query, opts, revision, opts.allSheets ? null : activeSheet],
  );

  // Ctrl+F again while open: back to the search box, its text selected.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [controller.find]);

  // A new search starts from the active cell.
  useEffect(() => setIndex(-1), [query, opts]);

  const go = (step: 1 | -1) => {
    if (matches.length === 0) return;
    const next = index < 0 ? firstFrom(controller, matches, step) : (index + step + matches.length) % matches.length;
    setIndex(next);
    const m = matches[next]!;
    controller.goTo(m.sheetId, m.row, m.col);
  };

  const close = () => controller.openFind(null);

  const replaceOne = () => {
    const { row, col } = controller.selection.active;
    const current = matches.find((m) => m.sheetId === controller.activeSheetId && m.row === row && m.col === col);
    if (current) replaceMatches(controller, [current], query, replacement, opts);
    go(1);
  };

  const replaceAll = () => {
    const count = replaceMatches(controller, matches, query, replacement, opts);
    toast.success(format(tf.replaced, { count }));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'h')) {
      e.preventDefault();
      controller.openFind(e.key === 'h' ? 'replace' : 'find');
    }
  };

  const status = !query ? '' : matches.length === 0 ? tf.noResults : index < 0 ? format(tf.count, { total: matches.length }) : format(tf.position, { current: index + 1, total: matches.length });
  const setOpt = (key: keyof FindOptions, value: boolean) => setOpts((o) => ({ ...o, [key]: value }));

  return (
    <div
      className="absolute right-4 top-2 z-30 flex w-[min(420px,calc(100%-2rem))] flex-col gap-2 rounded-md border bg-popover p-2 text-sm text-popover-foreground shadow-md"
      role="search"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-1">
        <div className="relative min-w-0 flex-1">
          <Input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tf.placeholder} aria-label={tf.placeholder} className="h-8 pr-20" />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground" aria-live="polite">
            {status}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => go(-1)} disabled={matches.length === 0} aria-label={tf.previous} title={tf.previous}>
          <ChevronUp className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" className="size-8" onClick={() => go(1)} disabled={matches.length === 0} aria-label={tf.next} title={tf.next}>
          <ChevronDown className="size-4" />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={tf.options} title={tf.options}>
              <Settings2 className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-60 flex-col gap-2 p-3 text-sm">
            {(['matchCase', 'wholeCell', 'formulas', 'allSheets'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2">
                <Checkbox checked={opts[key]} onCheckedChange={(v) => setOpt(key, v === true)} />
                {tf[key]}
              </label>
            ))}
          </PopoverContent>
        </Popover>
        {!controller.readOnly && (
          <Button
            variant={replacing ? 'secondary' : 'ghost'}
            size="icon"
            className="size-8"
            onClick={() => controller.openFind(replacing ? 'find' : 'replace')}
            aria-label={tf.replace}
            title={tf.replace}
          >
            <Replace className="size-4" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="size-8" onClick={close} aria-label={tf.close} title={tf.close}>
          <X className="size-4" />
        </Button>
      </div>
      {replacing && (
        <div className="flex items-center gap-1">
          <Input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder={tf.replacePlaceholder} aria-label={tf.replacePlaceholder} className="h-8 min-w-0 flex-1" />
          <Button variant="outline" size="sm" className="h-8" onClick={replaceOne} disabled={matches.length === 0}>
            {tf.replace}
          </Button>
          <Button variant="outline" size="sm" className="h-8" onClick={replaceAll} disabled={matches.length === 0}>
            {tf.replaceAll}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The first match after the active cell (before it, going back), wrapping round. */
function firstFrom(ctl: SheetController, matches: FindMatch[], step: 1 | -1): number {
  const { row, col } = ctl.selection.active;
  const here = (m: FindMatch) => m.sheetId === ctl.activeSheetId;
  const after = (m: FindMatch) => m.row > row || (m.row === row && m.col > col);
  const before = (m: FindMatch) => m.row < row || (m.row === row && m.col < col);
  if (step === 1) {
    // Past the last one here: the first on the next sheet searched (they follow the active sheet's).
    const i = matches.findIndex((m) => (here(m) && after(m)) || !here(m));
    return i >= 0 ? i : 0;
  }
  for (let i = matches.length - 1; i >= 0; i--) if (here(matches[i]!) && before(matches[i]!)) return i;
  return matches.length - 1;
}
