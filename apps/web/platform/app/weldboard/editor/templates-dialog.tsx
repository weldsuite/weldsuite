import { useMemo, useState } from 'react';
import { BUILT_IN_TEMPLATES, boardDisplay, Board, applyOp, displayToSvg, placeFragment, selectionBounds, type BuiltInTemplate, type Fragment, type TemplateCategory } from '@weldsuite/board-engine';
import { CachedMeasurer, MetricsMeasurer } from '@weldsuite/docs-engine';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

type I18n = ReturnType<typeof useI18n>;

/** A built-in template's fragment with its labels in the person's language. */
export function buildTemplate(template: BuiltInTemplate, t: I18n['t'], makeId: () => string): Fragment {
  const content = t.weldboard.templates.content as Record<string, string>;
  return template.build({ makeId, label: (key, english) => content[key] ?? english });
}

const previewMeasurer = new CachedMeasurer(new MetricsMeasurer());
const previews = new Map<string, string>();

/** A small SVG picture of a template, drawn from its fragment. */
export function templatePreview(id: string, fragment: Fragment): string {
  const cached = previews.get(id);
  if (cached) return cached;
  const board = Board.create();
  let n = 0;
  applyOp(board, placeFragment(board, fragment, { x: 0, y: 0, makeId: () => `p${++n}` }).op);
  const view = selectionBounds(board, board.elements.keys()) ?? { x: 0, y: 0, w: 100, h: 100 };
  const svg = displayToSvg(boardDisplay(board, { measurer: previewMeasurer }), { view, width: 320, padding: 40, background: '#f7f8fa' });
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  previews.set(id, url);
  return url;
}

export function TemplatesGallery({ onPick, compact = false }: { onPick: (template: BuiltInTemplate) => void; compact?: boolean }) {
  const { t } = useI18n();
  const tt = t.weldboard.templates;
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const names = tt.names as Record<string, string>;
  const descriptions = tt.descriptions as Record<string, string>;
  const shown = useMemo(
    () =>
      BUILT_IN_TEMPLATES.filter((tpl) => (category === 'all' || tpl.category === category) && (!query || `${names[tpl.id] ?? tpl.id} ${descriptions[tpl.id] ?? ''}`.toLowerCase().includes(query.toLowerCase()))),
    [category, query, names, descriptions],
  );
  const cats: (TemplateCategory | 'all')[] = ['all', 'meetings', 'ideation', 'planning', 'strategy', 'diagramming'];
  let ids = 0;
  return (
    <div className="flex flex-col gap-3">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tt.search} className="h-8 w-56" />
          {cats.map((cat) => (
            <button key={cat} type="button" onClick={() => setCategory(cat)} className={cn('rounded-full border px-3 py-1 text-xs', category === cat ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted')}>
              {tt.categories[cat]}
            </button>
          ))}
        </div>
      )}
      <ul className={cn(compact ? 'flex gap-4' : 'grid grid-cols-2 gap-3 sm:grid-cols-3')}>
        {(compact ? shown.slice(0, 6) : shown).map((tpl) => (
          <li key={tpl.id} className={cn(compact && 'w-44 shrink-0')}>
            <button type="button" onClick={() => onPick(tpl)} className="group flex w-full flex-col gap-1.5 text-left">
              <span className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-muted/40 transition group-hover:border-primary">
                <img src={templatePreview(tpl.id, buildTemplate(tpl, t, () => `t${++ids}`))} alt="" className="h-full w-full object-contain" />
              </span>
              <span className="truncate text-sm font-medium">{names[tpl.id] ?? tpl.id}</span>
              {!compact && <span className="line-clamp-2 text-xs text-muted-foreground">{descriptions[tpl.id]}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TemplatesDialog({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (template: BuiltInTemplate) => void }) {
  const { t } = useI18n();
  const tt = t.weldboard.templates;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tt.insertTitle}</DialogTitle>
          <DialogDescription>{tt.description}</DialogDescription>
        </DialogHeader>
        <TemplatesGallery
          onPick={(tpl) => {
            onPick(tpl);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
