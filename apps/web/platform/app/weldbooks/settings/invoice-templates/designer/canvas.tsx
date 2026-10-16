import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { BlockPlacement, InvoiceLayout } from '@weldsuite/books-domain/invoice-template/layout';
import type { InvoiceTemplateDocument, TemplateBlock, TemplateBlockType } from '@weldsuite/books-domain/invoice-template/schema';
import { renderPageSvg } from '@weldsuite/books-domain/invoice-template/svg';
import { PAPER_SIZES } from '@weldsuite/books-domain/invoice-template/schema';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { BlockBox } from './block-box';
import { minSizeOf } from './model/block-factory';
import type { EditorAction } from './model/editor-reducer';
import {
  idsInMarquee,
  rectFromPoints,
  resizeRect,
  snapMove,
  snapResize,
  unionRect,
  type Guide,
  type Rect,
  type ResizeHandle,
  type SnapContext,
} from './model/snapping';

/** Screen pixels within which an edge snaps to a guide. */
const SNAP_PX = 6;
/** Pixels a pointer has to travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;

export const BLOCK_DRAG_TYPE = 'application/x-weldsuite-invoice-block';

export interface CanvasApi {
  /** Top-left of the visible part of page one, in points: where a clicked palette block lands. */
  visibleOrigin: () => { x: number; y: number };
}

interface CanvasProps {
  doc: InvoiceTemplateDocument;
  layout: InvoiceLayout | null;
  selection: string[];
  /** Screen pixels per point. */
  scale: number;
  readOnly: boolean;
  dispatch: Dispatch<EditorAction>;
  apiRef: RefObject<CanvasApi | null>;
  onDropBlock: (type: TemplateBlockType, point: { x: number; y: number }) => void;
  /** Ctrl/Cmd + wheel: +1 zoom in, -1 zoom out. */
  onWheelZoom: (direction: 1 | -1) => void;
  className?: string;
}

type Gesture =
  | { kind: 'move'; id: number; start: { x: number; y: number }; startRects: Record<string, Rect>; union: Rect; others: Rect[]; moved: boolean; clickedId: string }
  | { kind: 'resize'; id: number; blockId: string; handle: ResizeHandle; start: { x: number; y: number }; startRect: Rect; others: Rect[]; min: { minW: number; minH: number } }
  | { kind: 'marquee'; start: { x: number; y: number }; base: string[]; additive: boolean; moved: boolean; last: string };

/** One page of the rendered invoice; only repaints when its markup changes. */
const PageSvg = memo(function PageSvg({ html }: Readonly<{ html: string }>) {
  return <div className="h-full w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: html }} />;
});

const rectOf = (b: TemplateBlock): Rect => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function hintFor(
  block: TemplateBlock,
  placement: BlockPlacement | undefined,
  belowTable: boolean,
  texts: { needsRoom: string; pushedDown: string; followsTable: string; movesToPage: string },
): { text: string; tone: 'warn' | 'info' } | null {
  if (block.hidden) return null;
  if (belowTable) return { text: texts.followsTable, tone: 'info' };
  if (!placement || block.type === 'lineItems') return null;
  if (placement.page > 0) return { text: texts.movesToPage.replace('{page}', String(placement.page + 1)), tone: 'warn' };
  if (placement.grew) return { text: texts.needsRoom, tone: 'warn' };
  if (placement.moved) return { text: texts.pushedDown, tone: 'warn' };
  return null;
}

/**
 * The page(s) of the invoice as rendered output, with an interaction layer on
 * the first page: one box per block to select, drag and resize, alignment
 * guides while dragging and a marquee on empty canvas.
 */
export function DesignerCanvas({ doc, layout, selection, scale, readOnly, dispatch, apiRef, onDropBlock, onWheelZoom, className }: Readonly<CanvasProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const gestureCounter = useRef(0);

  const paper = PAPER_SIZES[doc.paperSize];
  const pages = useMemo(() => (layout ? layout.pages.map((_, i) => renderPageSvg(layout, i, { withSize: false })) : []), [layout]);
  const placements = useMemo(() => new Map((layout?.placements ?? []).map((p) => [p.id, p])), [layout]);
  const table = doc.blocks.find((b) => b.type === 'lineItems');
  const tableBottom = table ? table.y + table.h : Number.POSITIVE_INFINITY;
  const selected = useMemo(() => new Set(selection), [selection]);

  // Latest values for the pointer handlers, so the handlers themselves stay stable.
  const live = useRef({ doc, scale, readOnly, selection, dispatch, paper });
  live.current = { doc, scale, readOnly, selection, dispatch, paper };

  useImperativeHandle(
    apiRef,
    () => ({
      visibleOrigin: () => {
        const scroller = scrollRef.current?.getBoundingClientRect();
        const page = pageRef.current?.getBoundingClientRect();
        const s = live.current.scale;
        if (!scroller || !page) return { x: 24, y: 24 };
        return {
          x: Math.max(0, (scroller.left - page.left) / s) + 16,
          y: Math.max(0, (scroller.top - page.top) / s) + 16,
        };
      },
    }),
    [],
  );

  useEffect(() => () => cleanupRef.current?.(), []);

  // Ctrl/Cmd + wheel zooms; React's wheel listeners are passive, so this one is native.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onWheelZoom(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheelZoom]);

  const toPt = useCallback((clientX: number, clientY: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    const s = live.current.scale;
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
  }, []);

  const snapContext = useCallback((others: Rect[], disabled: boolean): SnapContext => {
    const { doc: d, scale: s, paper: p } = live.current;
    return {
      page: { width: p.width, height: p.height },
      margins: d.margins,
      others,
      threshold: SNAP_PX / s,
      disabled,
    };
  }, []);

  /** Runs `onMove` once per animation frame while the pointer is down, flushes it on release. */
  const track = useCallback((onMove: (ev: PointerEvent) => void, onEnd: () => void) => {
    cleanupRef.current?.();
    let frame = 0;
    let last: PointerEvent | null = null;
    const move = (ev: PointerEvent) => {
      last = ev;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (last) onMove(last);
      });
    };
    const cleanup = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cleanupRef.current = null;
    };
    function up() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (last) onMove(last);
      cleanup();
      onEnd();
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    cleanupRef.current = cleanup;
  }, []);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    setGuides([]);
    setMarquee(null);
    live.current.dispatch({ type: 'endCoalesce' });
  }, []);

  const onBlockPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const { doc: d, selection: sel, dispatch: send, readOnly: ro } = live.current;

      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        send({ type: 'select', ids: [id], mode: 'toggle' });
        return;
      }
      const ids = sel.includes(id) ? sel : [id];
      if (!sel.includes(id)) send({ type: 'select', ids: [id] });
      if (ro) return;

      const movable = d.blocks.filter((b) => ids.includes(b.id) && !b.locked);
      if (movable.length === 0) return;
      const startRects = Object.fromEntries(movable.map((b) => [b.id, rectOf(b)]));
      const union = unionRect(Object.values(startRects));
      if (!union) return;
      const moving = new Set(movable.map((b) => b.id));
      const gesture: Gesture = {
        kind: 'move',
        id: ++gestureCounter.current,
        start: toPt(e.clientX, e.clientY),
        startRects,
        union,
        others: d.blocks.filter((b) => !b.hidden && !moving.has(b.id)).map(rectOf),
        moved: false,
        clickedId: id,
      };
      gestureRef.current = gesture;

      track(
        (ev) => {
          const g = gestureRef.current;
          if (!g || g.kind !== 'move') return;
          const pt = toPt(ev.clientX, ev.clientY);
          const dx = pt.x - g.start.x;
          const dy = pt.y - g.start.y;
          if (!g.moved) {
            if (Math.hypot(dx, dy) * live.current.scale < DRAG_THRESHOLD_PX) return;
            g.moved = true;
          }
          const proposed: Rect = { ...g.union, x: g.union.x + dx, y: g.union.y + dy };
          const snapped = snapMove(proposed, snapContext(g.others, ev.altKey));
          const ddx = snapped.rect.x - g.union.x;
          const ddy = snapped.rect.y - g.union.y;
          const rects: Record<string, Rect> = {};
          for (const [bid, r] of Object.entries(g.startRects)) rects[bid] = { ...r, x: r.x + ddx, y: r.y + ddy };
          live.current.dispatch({ type: 'setRects', rects, coalesce: `drag:${g.id}` });
          setGuides(snapped.guides);
        },
        () => {
          const g = gestureRef.current;
          // A click (no drag) on one block of a multi-selection selects just that block.
          if (g?.kind === 'move' && !g.moved && Object.keys(g.startRects).length > 1) {
            live.current.dispatch({ type: 'select', ids: [g.clickedId] });
          }
          endGesture();
        },
      );
    },
    [endGesture, snapContext, toPt, track],
  );

  const onHandleDown = useCallback(
    (e: ReactPointerEvent<HTMLSpanElement>, id: string, handle: ResizeHandle) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const { doc: d, readOnly: ro } = live.current;
      const block = d.blocks.find((b) => b.id === id);
      if (!block || block.locked || ro) return;
      const gesture: Gesture = {
        kind: 'resize',
        id: ++gestureCounter.current,
        blockId: id,
        handle,
        start: toPt(e.clientX, e.clientY),
        startRect: rectOf(block),
        others: d.blocks.filter((b) => !b.hidden && b.id !== id).map(rectOf),
        min: minSizeOf(block as TemplateBlock & { orientation?: string }),
      };
      gestureRef.current = gesture;

      track(
        (ev) => {
          const g = gestureRef.current;
          if (!g || g.kind !== 'resize') return;
          const pt = toPt(ev.clientX, ev.clientY);
          const aspect = ev.shiftKey;
          const raw = resizeRect(g.startRect, g.handle, pt.x - g.start.x, pt.y - g.start.y, { ...g.min, aspect });
          const snapped = aspect ? { rect: raw, guides: [] as Guide[] } : snapResize(raw, g.handle, snapContext(g.others, ev.altKey), g.min);
          live.current.dispatch({ type: 'setRects', rects: { [g.blockId]: snapped.rect }, coalesce: `resize:${g.id}` });
          setGuides(snapped.guides);
        },
        endGesture,
      );
    },
    [endGesture, snapContext, toPt, track],
  );

  const onBackdropPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Blocks and handles run their own gestures; the scrollbar is not canvas.
      if (target.closest('[data-block-id], [data-handle]')) return;
      const bounds = e.currentTarget.getBoundingClientRect();
      if (e.clientX >= bounds.left + e.currentTarget.clientWidth || e.clientY >= bounds.top + e.currentTarget.clientHeight) return;

      const { doc: d, selection: sel, dispatch: send } = live.current;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (!additive) send({ type: 'select', ids: [] });
      if (live.current.readOnly) return;

      gestureRef.current = { kind: 'marquee', start: toPt(e.clientX, e.clientY), base: additive ? sel : [], additive, moved: false, last: '' };
      const candidates = d.blocks.filter((b) => !b.hidden).map((b) => ({ id: b.id, ...rectOf(b) }));
      track(
        (ev) => {
          const g = gestureRef.current;
          if (!g || g.kind !== 'marquee') return;
          const pt = toPt(ev.clientX, ev.clientY);
          const rect = rectFromPoints(g.start, pt);
          if (!g.moved) {
            if (Math.hypot(rect.w, rect.h) * live.current.scale < DRAG_THRESHOLD_PX) return;
            g.moved = true;
          }
          setMarquee(rect);
          const hit = idsInMarquee(candidates, rect);
          const ids = g.additive ? [...new Set([...g.base, ...hit])] : hit;
          const key = ids.join('|');
          if (key !== g.last) {
            g.last = key;
            live.current.dispatch({ type: 'select', ids });
          }
        },
        endGesture,
      );
    },
    [endGesture, toPt, track],
  );

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (readOnly || !e.dataTransfer.types.includes(BLOCK_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    const type = e.dataTransfer.getData(BLOCK_DRAG_TYPE) as TemplateBlockType;
    if (readOnly || !type) return;
    e.preventDefault();
    onDropBlock(type, toPt(e.clientX, e.clientY));
  };

  const names = ti.blocks as Record<TemplateBlockType, string>;
  const hintTexts = ti.canvas;
  const single = selection.length === 1;
  const selectedRects = doc.blocks.filter((b) => selected.has(b.id)).map(rectOf);
  const group = selection.length > 1 ? unionRect(selectedRects) : null;

  const pageWidth = paper.width * scale;
  const pageHeight = paper.height * scale;

  return (
    <div
      ref={scrollRef}
      className={cn('relative min-h-0 flex-1 overflow-auto bg-muted/70 dark:bg-muted/30', className)}
      onPointerDown={onBackdropPointerDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="mx-auto flex w-max min-w-full flex-col items-center gap-6 px-10 py-10">
        {pages.length === 0 ? (
          <div ref={pageRef} className="rounded-md bg-background p-8 text-sm text-muted-foreground" style={{ width: pageWidth }} />
        ) : null}
        {pages.map((html, index) => (
          <div key={index} className="flex flex-col items-center gap-2">
            <div
              ref={index === 0 ? pageRef : undefined}
              className="relative shrink-0 bg-white shadow-lg ring-1 ring-black/10"
              style={{ width: pageWidth, height: pageHeight }}
            >
              <PageSvg html={html} />

              {index === 0 ? (
                <div className="absolute inset-0">
                  {doc.blocks.map((block) => {
                    const placement = placements.get(block.id);
                    const belowTable = Boolean(table) && block.id !== table?.id && !block.everyPage && block.y >= tableBottom - 0.5;
                    const hint = hintFor(block, placement, belowTable, hintTexts);
                    return (
                      <BlockBox
                        key={block.id}
                        block={block}
                        scale={scale}
                        selected={selected.has(block.id)}
                        single={single}
                        readOnly={readOnly}
                        name={names[block.type]}
                        everyPageLabel={hintTexts.everyPage}
                        followsTableLabel={hintTexts.followsTableBadge}
                        lockedLabel={hintTexts.locked}
                        hiddenLabel={hintTexts.hidden}
                        chooseImageLabel={hintTexts.chooseImage}
                        hint={hint?.text ?? null}
                        hintTone={hint?.tone ?? 'info'}
                        belowTable={belowTable}
                        onPointerDown={onBlockPointerDown}
                        onHandleDown={onHandleDown}
                      />
                    );
                  })}

                  {/* Where blocks that grew or were pushed down really print. */}
                  {doc.blocks.map((block) => {
                    const p = placements.get(block.id);
                    if (!p || p.page !== 0 || block.hidden || block.id === table?.id) return null;
                    const below = block.y >= tableBottom - 0.5 && !block.everyPage;
                    if (below || (!p.grew && !p.moved)) return null;
                    return (
                      <div
                        key={`ghost-${block.id}`}
                        aria-hidden
                        className="pointer-events-none absolute border border-dashed border-amber-500/60 bg-amber-500/5"
                        style={{ left: p.x * scale, top: p.y * scale, width: p.w * scale, height: p.h * scale }}
                      />
                    );
                  })}

                  {group ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute border border-dashed border-primary"
                      style={{ left: group.x * scale, top: group.y * scale, width: group.w * scale, height: group.h * scale }}
                    >
                      <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-primary px-1.5 py-px text-[10px] font-medium leading-4 text-primary-foreground">
                        {hintTexts.selected.replace('{count}', String(selection.length))}
                      </span>
                    </div>
                  ) : null}

                  {guides.map((g) => (
                    <div
                      key={`${g.axis}-${g.pos}`}
                      aria-hidden
                      className="pointer-events-none absolute bg-fuchsia-500"
                      style={
                        g.axis === 'x'
                          ? { left: g.pos * scale - 0.5, top: g.start * scale, width: 1, height: (g.end - g.start) * scale }
                          : { top: g.pos * scale - 0.5, left: g.start * scale, height: 1, width: (g.end - g.start) * scale }
                      }
                    />
                  ))}

                  {marquee ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute border border-primary bg-primary/10"
                      style={{ left: marquee.x * scale, top: marquee.y * scale, width: marquee.w * scale, height: marquee.h * scale }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            {pages.length > 1 ? (
              <span className="text-xs text-muted-foreground">
                {ti.designer.pageOf.replace('{page}', String(index + 1)).replace('{total}', String(pages.length))}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
