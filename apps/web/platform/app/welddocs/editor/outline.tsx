import { useMemo, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { BODY, caretAt } from '@weldsuite/docs-engine';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';

/** The document's headings down the left side; a click moves there. */
export function Outline({ controller }: { controller: DocController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const to = t.welddocs.outline;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => controller.outline(), [controller.contentVersion]);
  const caret = controller.selection.story === BODY ? controller.selection.head : -1;
  const current = items.reduce<number>((best, item, i) => (item.pos <= caret ? i : best), -1);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-background">
      <div className="flex h-10 items-center justify-between px-3">
        <span className="text-sm font-medium">{to.title}</span>
        <button type="button" className="rounded p-1 hover:bg-accent" aria-label={to.close} onClick={() => controller.setView({ showOutline: false })}>
          <X className="size-4" />
        </button>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!items.length && <p className="px-2 text-xs text-muted-foreground">{to.empty}</p>}
        {items.map((item, i) => (
          <button
            key={`${item.pos}-${i}`}
            type="button"
            className={`block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent ${i === current ? 'font-medium text-blue-600' : 'text-muted-foreground'}`}
            style={{ paddingLeft: 8 + Math.max(0, item.level - 1) * 12 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => controller.setSelection(caretAt(BODY, item.pos))}
          >
            {item.text}
          </button>
        ))}
      </nav>
    </aside>
  );
}
