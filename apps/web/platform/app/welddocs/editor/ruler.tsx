import { useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { PX_PER_PT } from './view/page-view';

const CM = 72 / 2.54;
/** The ruler's tick spacing: a quarter centimetre. */
const QUARTER = CM / 4;

/** The nearest tick to a position: ticks are counted from the left margin. */
function onTick(value: number, marginLeft: number): number {
  return marginLeft + Math.round((value - marginLeft) / QUARTER) * QUARTER;
}

/**
 * The horizontal ruler over the page: margins (drag to change them) and the
 * caret paragraph's indents (first line, left, right).
 */
export function Ruler({ controller, scrollRef }: { controller: DocController; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const tr = t.welddocs.ruler;
  const [scroll, setScroll] = useState({ left: 0, width: 800 });
  const [drag, setDrag] = useState<{ kind: Handle; value: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setScroll({ left: el.scrollLeft, width: el.clientWidth });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef]);

  const caretPage = controller.pages[controller.caretPage()] ?? controller.pages[0];
  if (!caretPage) return null;
  const s = caretPage.section;
  const scale = controller.zoom * PX_PER_PT;
  const width = s.pageWidth * scale;
  const maxWidth = Math.max(...controller.pages.map((p) => p.width)) * scale;
  const left = Math.max(16, (Math.max(scroll.width, maxWidth + 32) - width) / 2) - scroll.left;
  const para = controller.paragraph();
  const contentWidth = s.pageWidth - s.marginLeft - s.marginRight;
  const values: Record<Handle, number> = {
    marginLeft: s.marginLeft,
    marginRight: s.pageWidth - s.marginRight,
    indentLeft: s.marginLeft + (para.indentLeft ?? 0),
    indentFirst: s.marginLeft + (para.indentLeft ?? 0) + (para.indentFirst ?? 0),
    indentRight: s.pageWidth - s.marginRight - (para.indentRight ?? 0),
  };
  if (drag) values[drag.kind] = drag.value;
  // An indent marker sits on the nearest tick, centred on its 1px line (a tick is drawn from its x to x + 1).
  const atTick = (value: number) => onTick(value, s.marginLeft) * scale + 0.5;

  const startDrag = (kind: Handle) => (e: React.PointerEvent) => {
    if (controller.readOnly) return;
    e.preventDefault();
    const origin = e.clientX;
    const start = values[kind];
    // Everything lands on a tick; the left margin, which the ticks count from, on a quarter centimetre from the page edge.
    const snap = (ev: PointerEvent) => {
      const raw = start + (ev.clientX - origin) / scale;
      return kind === 'marginLeft' ? Math.round(raw / QUARTER) * QUARTER : onTick(raw, s.marginLeft);
    };
    const move = (ev: PointerEvent) => setDrag({ kind, value: snap(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      apply(controller, kind, snap(ev), contentWidth);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="relative h-6 shrink-0 overflow-hidden border-b bg-muted/30 select-none" aria-hidden>
      <div className="absolute top-0 h-full bg-background" style={{ left, width }}>
        {rulerTicks(s.marginLeft, s.pageWidth, scale).map((tick) => (
          <RulerTick key={tick.at} tick={tick} />
        ))}
        <HandleMark x={values.marginLeft * scale} title={tr.leftMargin} onPointerDown={startDrag('marginLeft')} kind="margin" />
        <HandleMark x={values.marginRight * scale} title={tr.rightMargin} onPointerDown={startDrag('marginRight')} kind="margin" />
        <HandleMark x={atTick(values.indentLeft)} title={tr.leftIndent} onPointerDown={startDrag('indentLeft')} kind="line" />
        <HandleMark x={atTick(values.indentFirst)} title={tr.firstLine} onPointerDown={startDrag('indentFirst')} kind="bar" />
        <HandleMark x={atTick(values.indentRight)} title={tr.rightIndent} onPointerDown={startDrag('indentRight')} kind="line" />
      </div>
    </div>
  );
}

type Handle = 'marginLeft' | 'marginRight' | 'indentLeft' | 'indentFirst' | 'indentRight';

interface Tick {
  /** Quarter centimetres from the left margin; negative inside it. */
  at: number;
  /** Pixels from the page's left edge. */
  x: number;
  kind: 'number' | 'half' | 'quarter';
}

/**
 * The marks, counted from the left margin: every centimetre a tick with its
 * number above it (outward into the left margin too), the same tick at the
 * half and short ones at the quarters. Nothing at the margin itself,
 * where the indent markers sit.
 */
function rulerTicks(marginLeft: number, pageWidth: number, scale: number): Tick[] {
  const ticks: Tick[] = [];
  for (let at = -Math.floor(marginLeft / QUARTER); at * QUARTER <= pageWidth - marginLeft; at++) {
    if (at === 0) continue;
    let kind: Tick['kind'] = 'quarter';
    if (at % 4 === 0) kind = 'number';
    else if (at % 2 === 0) kind = 'half';
    ticks.push({ at, x: (marginLeft + at * QUARTER) * scale, kind });
  }
  return ticks;
}

const TICK_HEIGHT: Record<Tick['kind'], string> = { number: 'h-1.5', half: 'h-1.5', quarter: 'h-[3px]' };

function RulerTick({ tick }: { tick: Tick }) {
  const line = <div className={`absolute bottom-0 w-px bg-muted-foreground/60 ${TICK_HEIGHT[tick.kind]}`} style={{ left: tick.x }} />;
  if (tick.kind !== 'number') return line;
  return (
    <>
      {/* Centred on the 1px line under it. */}
      <span className="absolute top-[6px] -translate-x-1/2 text-[10px] leading-none tabular-nums text-muted-foreground" style={{ left: tick.x + 0.5 }}>
        {Math.abs(tick.at / 4)}
      </span>
      {line}
    </>
  );
}

/**
 * A margin is an invisible strip to drag; the first-line indent is a blue bar
 * above the left indent's blue line, and the right indent a blue line too.
 * A line grabs on 8px around it, so the 2px line stays easy to drag.
 */
function HandleMark({ x, title, onPointerDown, kind }: { x: number; title: string; onPointerDown: (e: React.PointerEvent) => void; kind: 'margin' | 'line' | 'bar' }) {
  if (kind === 'margin') {
    return <div title={title} onPointerDown={onPointerDown} className="absolute top-0 h-full w-2 -translate-x-1/2 cursor-col-resize" style={{ left: x }} />;
  }
  if (kind === 'bar') {
    return <div title={title} onPointerDown={onPointerDown} className="absolute top-[7px] h-1 w-[11px] -translate-x-1/2 cursor-ew-resize rounded-[1px] bg-primary" style={{ left: x }} />;
  }
  return (
    <div title={title} onPointerDown={onPointerDown} className="absolute top-[12px] bottom-0 flex w-2 -translate-x-1/2 cursor-ew-resize justify-center" style={{ left: x }}>
      <div className="h-full w-0.5 rounded-full bg-primary" />
    </div>
  );
}

function apply(controller: DocController, kind: Handle, value: number, contentWidth: number): void {
  const s = controller.section;
  const para = controller.paragraph();
  const left = para.indentLeft ?? 0;
  switch (kind) {
    case 'marginLeft':
      controller.setSection({ marginLeft: clamp(value, 0, s.pageWidth - s.marginRight - 72) });
      return;
    case 'marginRight':
      controller.setSection({ marginRight: clamp(s.pageWidth - value, 0, s.pageWidth - s.marginLeft - 72) });
      return;
    case 'indentLeft': {
      const next = clamp(value - s.marginLeft, -s.marginLeft, contentWidth - 36);
      // The first line stays where it was.
      controller.setParagraph({ indentLeft: round(next) || null, indentFirst: round(left + (para.indentFirst ?? 0) - next) || null });
      return;
    }
    case 'indentFirst':
      controller.setParagraph({ indentFirst: round(clamp(value - s.marginLeft - left, -left - s.marginLeft, contentWidth - left)) || null });
      return;
    case 'indentRight':
      controller.setParagraph({ indentRight: round(clamp(s.pageWidth - s.marginRight - value, -s.marginRight, contentWidth - 36)) || null });
      return;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
