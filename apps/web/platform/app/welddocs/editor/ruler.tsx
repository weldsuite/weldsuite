import { useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { PX_PER_PT } from './view/page-view';

const CM = 72 / 2.54;

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

  const startDrag = (kind: Handle) => (e: React.PointerEvent) => {
    if (controller.readOnly) return;
    e.preventDefault();
    const origin = e.clientX;
    const start = values[kind];
    const move = (ev: PointerEvent) => {
      // Snap to an eighth of a centimetre.
      const raw = start + (ev.clientX - origin) / scale;
      setDrag({ kind, value: Math.round(raw / (CM / 8)) * (CM / 8) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const raw = start + (ev.clientX - origin) / scale;
      const value = Math.round(raw / (CM / 8)) * (CM / 8);
      setDrag(null);
      apply(controller, kind, value, contentWidth);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const ticks: number[] = [];
  for (let cm = 0; cm * CM <= s.pageWidth; cm += 0.5) ticks.push(cm);

  return (
    <div className="relative h-6 shrink-0 overflow-hidden border-b bg-muted/30 select-none" aria-hidden>
      <div className="absolute top-0 h-full bg-background" style={{ left, width }}>
        <div className="absolute top-0 h-full bg-muted" style={{ left: 0, width: values.marginLeft * scale }} />
        <div className="absolute top-0 h-full bg-muted" style={{ left: values.marginRight * scale, right: 0 }} />
        {ticks.map((cm) => {
          const x = (cm * CM - s.marginLeft) * scale + s.marginLeft * scale;
          const whole = Number.isInteger(cm);
          const label = Math.round(Math.abs(cm * CM - s.marginLeft) / CM);
          return (
            <div key={cm} className="absolute bottom-0" style={{ left: x }}>
              <div className={`w-px bg-muted-foreground/50 ${whole ? 'h-2' : 'h-1'}`} />
              {whole && cm > 0 && label > 0 && <span className="absolute -top-0.5 -translate-x-1/2 text-[9px] text-muted-foreground">{label}</span>}
            </div>
          );
        })}
        <HandleMark x={values.marginLeft * scale} title={tr.leftMargin} onPointerDown={startDrag('marginLeft')} kind="margin" />
        <HandleMark x={values.marginRight * scale} title={tr.rightMargin} onPointerDown={startDrag('marginRight')} kind="margin" />
        <HandleMark x={values.indentFirst * scale} title={tr.firstLine} onPointerDown={startDrag('indentFirst')} kind="down" />
        <HandleMark x={values.indentLeft * scale} title={tr.leftIndent} onPointerDown={startDrag('indentLeft')} kind="up" />
        <HandleMark x={values.indentRight * scale} title={tr.rightIndent} onPointerDown={startDrag('indentRight')} kind="up" />
      </div>
    </div>
  );
}

type Handle = 'marginLeft' | 'marginRight' | 'indentLeft' | 'indentFirst' | 'indentRight';

function HandleMark({ x, title, onPointerDown, kind }: { x: number; title: string; onPointerDown: (e: React.PointerEvent) => void; kind: 'margin' | 'up' | 'down' }) {
  if (kind === 'margin') {
    return <div title={title} onPointerDown={onPointerDown} className="absolute top-0 h-full w-2 -translate-x-1/2 cursor-col-resize" style={{ left: x }} />;
  }
  const triangle = kind === 'down' ? 'border-t-[6px] border-t-blue-600 top-0' : 'border-b-[6px] border-b-blue-600 bottom-0';
  return (
    <div
      title={title}
      onPointerDown={onPointerDown}
      className={`absolute h-0 w-0 -translate-x-1/2 cursor-ew-resize border-x-[5px] border-x-transparent ${triangle}`}
      style={{ left: x }}
    />
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
