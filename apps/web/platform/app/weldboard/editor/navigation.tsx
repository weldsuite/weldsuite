import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, Minus, Plus, Presentation } from 'lucide-react';
import { selectionBounds, type BoardElement, type Rect } from '@weldsuite/board-engine';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Kbd } from '@weldsuite/ui/components/kbd';
import { isMacPlatform, shortcutKeyLabels } from '@weldsuite/ui/lib/shortcut';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { nextZoom } from './model/camera';
import { BarButton, SIDE_PANEL, SIDE_PANEL_HEADER } from './ui';

export function ZoomControls({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const tz = t.weldboard.editor.zoom;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-2" role="toolbar" aria-orientation="horizontal" aria-label={tz.label}>
      <BarButton label={tz.out} keys={['mod', '-']} side="bottom" onClick={() => c.zoomTo(nextZoom(c.camera.zoom, -1))}>
        <Minus />
      </BarButton>
      <BarButton label={tz.reset} keys={['mod', '0']} side="bottom" onClick={() => c.zoomTo(1)} className="h-8 min-w-12 rounded-md px-1 text-xs tabular-nums hover:bg-accent">
        {Math.round(c.camera.zoom * 100)}%
      </BarButton>
      <BarButton label={tz.in} keys={['mod', '+']} side="bottom" onClick={() => c.zoomTo(nextZoom(c.camera.zoom, 1))}>
        <Plus />
      </BarButton>
    </div>
  );
}

const MINIMAP_W = 200;
const MINIMAP_H = 140;

/** An element's colour on the minimap. */
function minimapFill(el: BoardElement): string {
  if (el.type === 'frame') return '#ffffff';
  if (el.type === 'sticky') return el.fill ?? '#fff9b1';
  if (el.type === 'pen') return '#9ca3af';
  return el.fill && el.fill !== 'transparent' ? el.fill : '#cbd5e1';
}

/** A small map of the whole board with the visible area; click or drag to move there. */
export function Minimap({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<Rect | null>(null);
  useEffect(() => {
    const draw = () => {
      const cv = canvas.current;
      const ctx = cv?.getContext('2d');
      if (!cv || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = MINIMAP_W * dpr;
      cv.height = MINIMAP_H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
      const view = c.visible();
      const all = selectionBounds(c.board, c.board.elements.keys());
      const r = all ? union(all, view) : view;
      const pad = Math.max(r.w, r.h) * 0.05;
      const b = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
      const scale = Math.min(MINIMAP_W / b.w, MINIMAP_H / b.h);
      area.current = { x: b.x - (MINIMAP_W / scale - b.w) / 2, y: b.y - (MINIMAP_H / scale - b.h) / 2, w: MINIMAP_W / scale, h: MINIMAP_H / scale };
      const map = (x: number, y: number) => [(x - area.current!.x) * scale, (y - area.current!.y) * scale] as const;
      for (const el of c.board.paintOrder()) {
        if (el.type === 'connector' || el.type === 'comment' || el.type === 'group') continue;
        const [x, y] = map(el.x, el.y);
        ctx.fillStyle = minimapFill(el);
        ctx.fillRect(x, y, Math.max(1, el.w * scale), Math.max(1, el.h * scale));
        if (el.type === 'frame') {
          ctx.strokeStyle = '#cbd5e1';
          ctx.strokeRect(x, y, el.w * scale, el.h * scale);
        }
      }
      const [vx, vy] = map(view.x, view.y);
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.fillStyle = 'rgba(37,99,235,0.08)';
      ctx.fillRect(vx, vy, view.w * scale, view.h * scale);
      ctx.strokeRect(vx, vy, view.w * scale, view.h * scale);
    };
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };
    draw();
    const off = c.onRender(schedule);
    return () => {
      off();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [c]);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = area.current;
    if (!a) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = a.x + ((e.clientX - r.left) / MINIMAP_W) * a.w;
    const y = a.y + ((e.clientY - r.top) / MINIMAP_H) * a.h;
    c.setCamera({ ...c.camera, x: x - c.viewport.width / 2 / c.camera.zoom, y: y - c.viewport.height / 2 / c.camera.zoom }, true);
  };

  return (
    <canvas
      ref={canvas}
      aria-label={t.weldboard.editor.minimap}
      role="img"
      className="pointer-events-auto cursor-pointer rounded-xl border bg-background shadow-md"
      style={{ width: MINIMAP_W, height: MINIMAP_H }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        jump(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons) jump(e);
      }}
    />
  );
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Frames in presentation order (slides first), to jump to and reorder. */
export function slideFrames(c: BoardController): { slides: BoardElement[]; others: BoardElement[] } {
  const frames = [...c.board.elements.values()].filter((e) => e.type === 'frame');
  const slides = frames.filter((f) => f.slide !== undefined).sort((a, b) => a.slide! - b.slide! || (a.id < b.id ? -1 : 1));
  const others = frames.filter((f) => f.slide === undefined).sort((a, b) => a.y - b.y || a.x - b.x);
  return { slides, others };
}

export function FramesPanel({ controller: c, onPresent, onClose }: { controller: BoardController; onPresent: (frameId?: string) => void; onClose: () => void }) {
  const { t, format } = useI18n();
  const tf = t.weldboard.editor.frames;
  const { slides, others } = slideFrames(c);
  const move = (index: number, dir: -1 | 1) => {
    const a = slides[index];
    const b = slides[index + dir];
    if (!a || !b) return;
    c.apply({ type: 'batch', ops: [{ type: 'set', id: a.id, patch: { slide: b.slide } }, { type: 'set', id: b.id, patch: { slide: a.slide } }] });
  };
  const go = (f: BoardElement) => {
    c.select([f.id]);
    c.showRect({ x: f.x, y: f.y, w: f.w, h: f.h }, { maxZoom: 4, margin: 32 });
  };
  const row = (f: BoardElement, index: number | null) => (
    <li key={f.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => go(f)} title={tf.go}>
        {index !== null && <span className="mr-2 tabular-nums text-muted-foreground">{index + 1}</span>}
        {f.name || format(t.weldboard.editor.frameName, { n: (index ?? 0) + 1 })}
      </button>
      {index !== null && !c.readOnly && (
        <span className="hidden gap-0.5 group-hover:flex">
          <BarButton label={tf.moveUp} onClick={() => move(index, -1)} disabled={index === 0} className="inline-flex size-6 items-center justify-center rounded hover:bg-accent [&_svg]:size-3.5">
            <ArrowUp />
          </BarButton>
          <BarButton label={tf.moveDown} onClick={() => move(index, 1)} disabled={index === slides.length - 1} className="inline-flex size-6 items-center justify-center rounded hover:bg-accent [&_svg]:size-3.5">
            <ArrowDown />
          </BarButton>
        </span>
      )}
    </li>
  );
  return (
    <aside className={SIDE_PANEL} aria-label={tf.title}>
      <div className={SIDE_PANEL_HEADER}>
        <h2 className="text-sm font-semibold">{tf.title}</h2>
        <div className="flex gap-1">
          <BarButton label={t.weldboard.editor.present.start} onClick={() => onPresent()} disabled={slides.length + others.length === 0}>
            <Presentation />
          </BarButton>
          <BarButton label={t.common.actions.close} onClick={onClose}>
            <Plus className="rotate-45" />
          </BarButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {slides.length + others.length === 0 && <p className="p-2 text-sm text-muted-foreground">{tf.empty}</p>}
        {slides.length > 0 && (
          <>
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{tf.slides}</p>
            <ol>{slides.map((f, i) => row(f, i))}</ol>
          </>
        )}
        {others.length > 0 && (
          <>
            <p className={cn('px-2 pb-1 text-xs font-medium text-muted-foreground', slides.length > 0 && 'pt-3')}>{tf.notInPresentation}</p>
            <ul>{others.map((f) => row(f, null))}</ul>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * One shortcut: keys pressed together, written with `mod`, `shift`, `alt` and
 * `delete` for the platform's names; `|` between two alternatives ("] or [").
 */
type ShortcutKeys = string[];

/** One key as the platform names it. */
function keyLabel(key: string, mac: boolean): string {
  if (key === 'delete') return mac ? '⌫' : 'Del';
  if (key === '|') return key;
  return shortcutKeyLabels([key], mac)[0]!;
}

/** The keys of a shortcut as the platform names them: ⌘ ⌥ ⇧ ⌫ on a Mac, Ctrl Alt Shift Del elsewhere. */
function keyLabels(keys: ShortcutKeys, mac: boolean): string[] {
  return keys.map((k) => keyLabel(k, mac));
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.shortcuts;
  const i = ts.items;
  const mac = isMacPlatform();
  // Tools, view and text in the first column; editing, the longest, in the second.
  const groups: [string, [string, ShortcutKeys][]][] = [
    [ts.tools, [[i.select, ['V']], [i.hand, ['H']], [i.sticky, ['N']], [i.shape, ['S']], [i.text, ['T']], [i.connector, ['L']], [i.pen, ['P']], [i.highlighter, ['shift', 'P']], [i.eraser, ['E']], [i.frame, ['F']], [i.comment, ['C']], [i.mindmap, ['M']]]],
    [ts.view, [[i.pan, ['Space', i.drag]], [i.zoom, ['mod', i.scroll]], [i.fit, ['shift', '1']], [i.zoomSelection, ['shift', '2']], [i.present, ['F5']], [i.find, ['mod', 'F']], [i.shortcuts, ['?']]]],
    [ts.text, [[i.edit, ['Enter']], [i.finish, ['Esc']], [i.bold, ['mod', 'B']], [i.italic, ['mod', 'I']], [i.underline, ['mod', 'U']], [i.strike, ['mod', 'shift', 'S']]]],
    [
      ts.editing,
      [
        [i.undo, ['mod', 'Z']],
        [i.redo, ['mod', 'shift', 'Z']],
        [i.selectAll, ['mod', 'A']],
        [i.copy, ['mod', 'C']],
        [i.paste, ['mod', 'V']],
        [i.duplicate, ['mod', 'D']],
        [i.group, ['mod', 'G']],
        [i.ungroup, ['mod', 'shift', 'G']],
        [i.lock, ['mod', 'L']],
        [i.link, ['mod', 'K']],
        [i.delete, ['delete']],
        [i.nudge, ['←↑→↓']],
        [i.front, ['mod', ']']],
        [i.back, ['mod', '[']],
        [i.forward, [']', '|', '[']],
        [i.multi, ['shift', i.click]],
        [i.dragCopy, ['alt', i.drag]],
        [i.noSnap, ['alt']],
        [i.square, ['shift']],
        [i.child, ['Tab', '|', 'Enter']],
        [i.copyStyle, ['mod', 'alt', 'C']],
        [i.pasteStyle, ['mod', 'alt', 'P']],
      ],
    ],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The title stays in place while the list scrolls under it. */}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
        </DialogHeader>
        {/* Columns, not a grid: a short group doesn't leave a gap beside a long one. */}
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 sm:columns-2 sm:gap-8">
          {groups.map(([title, items]) => (
            <section key={title} className="mb-6 break-inside-avoid">
              <h3 className="mb-2 text-sm font-semibold">{title}</h3>
              <ul className="space-y-1.5">
                {items.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">{label}</span>
                    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                      {keyLabels(keys, mac).map((k, n) =>
                        k === '|' ? (
                          <span key={n} className="text-xs text-muted-foreground">
                            /
                          </span>
                        ) : (
                          <Kbd key={n}>{k}</Kbd>
                        ),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
