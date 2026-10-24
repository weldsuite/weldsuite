import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';

/** Find and replace, floating over the top right of the pages. */
export function FindBar({ controller }: { controller: DocController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t, format } = useI18n();
  const tf = t.welddocs.find;
  const find = controller.find;
  const inputRef = useRef<HTMLInputElement>(null);
  const [replacement, setReplacement] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  if (!find) return null;
  const count = find.matches.length;
  const set = (patch: Partial<typeof find.options> & { query?: string }) => {
    const { query = find.query, ...options } = patch;
    controller.setFind(query, { ...find.options, ...options });
  };

  return (
    <div className="absolute right-4 top-2 z-20 flex w-[22rem] flex-col gap-2 rounded-lg border bg-background p-3 shadow-lg" onKeyDown={(e) => e.key === 'Escape' && controller.closeFind()}>
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={find.query}
          placeholder={tf.find}
          aria-label={tf.find}
          onChange={(e) => set({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              controller.findStep(e.shiftKey ? -1 : 1);
            }
          }}
          className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-sm outline-none focus:border-primary"
        />
        <span className="w-16 shrink-0 text-center text-xs text-muted-foreground">{count ? format(tf.count, { index: find.index + 1, count }) : find.query ? tf.none : ''}</span>
        <button type="button" className="rounded p-1 hover:bg-accent disabled:opacity-40" aria-label={tf.previous} disabled={!count} onClick={() => controller.findStep(-1)}>
          <ChevronUp className="size-4" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-accent disabled:opacity-40" aria-label={tf.next} disabled={!count} onClick={() => controller.findStep(1)}>
          <ChevronDown className="size-4" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-accent" aria-label={tf.close} onClick={() => controller.closeFind()}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <Check label={tf.matchCase} checked={!!find.options.matchCase} onChange={(v) => set({ matchCase: v })} />
        <Check label={tf.wholeWord} checked={!!find.options.wholeWord} onChange={(v) => set({ wholeWord: v })} />
        <Check label={tf.regex} checked={!!find.options.regex} onChange={(v) => set({ regex: v })} />
      </div>
      {!controller.readOnly && (
        <div className="flex items-center gap-1">
          <input
            value={replacement}
            placeholder={tf.replace}
            aria-label={tf.replace}
            onChange={(e) => setReplacement(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-sm outline-none focus:border-primary"
          />
          <button type="button" className="h-8 rounded border px-2 text-xs hover:bg-accent disabled:opacity-40" disabled={!count} onClick={() => controller.replaceCurrent(replacement)}>
            {tf.replaceOne}
          </button>
          <button
            type="button"
            className="h-8 rounded border px-2 text-xs hover:bg-accent disabled:opacity-40"
            disabled={!count}
            onClick={() => toast.success(format(tf.replaced, { count: controller.replaceAll(replacement) }))}
          >
            {tf.replaceAll}
          </button>
        </div>
      )}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
