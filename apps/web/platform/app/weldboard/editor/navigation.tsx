import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, Grid3x3, Map as MapIcon, Maximize, Minus, Plus, Presentation, Scan } from 'lucide-react';
import { selectionBounds, type BoardElement, type Rect } from '@weldsuite/board-engine';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Kbd } from '@weldsuite/ui/components/kbd';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { nextZoom } from './model/camera';
import { BarButton, Divider } from './ui';

export function ZoomControls({ controller: c, minimap, onToggleMinimap }: { controller: BoardController; minimap: boolean; onToggleMinimap: () => void }) {
  const { t } = useI18n();
  const tz = t.weldboard.editor.zoom;
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-background p-1 shadow-md">
      <BarButton label={tz.grid} active={c.showGrid} onClick={() => {
        c.showGrid = !c.showGrid;
        c.changed();
      }}>
        <Grid3x3 />
      </BarButton>
      <BarButton label={tz.minimap} active={minimap} onClick={onToggleMinimap}>
        <MapIcon />
      </BarButton>
      <Divider />
      <BarButton label={tz.out} onClick={() => c.zoomTo(nextZoom(c.camera.zoom, -1))}>
        <Minus />
      </BarButton>
      <BarButton label={tz.reset} onClick={() => c.zoomTo(1)} className="h-8 min-w-14 rounded-md px-1 text-xs tabular-nums hover:bg-accent">
        {Math.round(c.camera.zoom * 100)}%
      </BarButton>
      <BarButton label={tz.in} onClick={() => c.zoomTo(nextZoom(c.camera.zoom, 1))}>
        <Plus />
      </BarButton>
      <BarButton label={tz.fit} onClick={() => c.zoomToFit()}>
        <Maximize />
      </BarButton>
      {c.selection.size > 0 && (
        <BarButton label={tz.selection} onClick={() => c.zoomToSelection()}>
          <Scan />
        </BarButton>
      )}
    </div>
  );
}

const MINIMAP_W = 200;
const MINIMAP_H = 140;

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
        ctx.fillStyle = el.type === 'frame' ? '#ffffff' : el.type === 'sticky' ? (el.fill ?? '#fff9b1') : el.type === 'pen' ? '#9ca3af' : (el.fill && el.fill !== 'transparent' ? el.fill : '#cbd5e1');
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
    <aside className="pointer-events-auto flex max-h-[70vh] w-64 flex-col rounded-xl border bg-background shadow-md">
      <div className="flex items-center justify-between border-b px-3 py-2">
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

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const ts = t.weldboard.editor.shortcuts;
  const i = ts.items;
  const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const groups: [string, [string, string[]][]][] = [
    [ts.tools, [[i.select, ['V']], [i.hand, ['H']], [i.sticky, ['N']], [i.shape, ['S']], [i.text, ['T']], [i.connector, ['L']], [i.pen, ['P']], [i.eraser, ['E']], [i.frame, ['F']], [i.comment, ['C']], [i.mindmap, ['M']]]],
    [ts.editing, [[i.undo, [mod, 'Z']], [i.redo, [mod, 'Shift', 'Z']], [i.duplicate, [mod, 'D']], [i.group, [mod, 'G']], [i.ungroup, [mod, 'Shift', 'G']], [i.lock, [mod, 'L']], [i.delete, ['Del']], [i.nudge, ['←↑→↓']], [i.front, [mod, '] / [']], [i.forward, ['] / [']], [i.multi, ['Shift', 'click']], [i.dragCopy, ['Alt', 'drag']], [i.noSnap, ['Alt']], [i.square, ['Shift']], [i.child, ['Tab / Enter']]]],
    [ts.view, [[i.pan, ['Space', 'drag']], [i.zoom, [mod, 'scroll']], [i.fit, ['Shift', '1']], [i.zoomSelection, ['Shift', '2']], [i.present, ['F5']]]],
    [ts.text, [[i.edit, ['Enter']], [i.finish, ['Esc']], [i.bold, [mod, 'B']], [i.italic, [mod, 'I']], [i.underline, [mod, 'U']]]],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map(([title, items]) => (
            <section key={title}>
              <h3 className="mb-2 text-sm font-semibold">{title}</h3>
              <ul className="space-y-1.5">
                {items.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-sm">
                    <span>{label}</span>
                    <span className="flex gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
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
