import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardController } from './model/board-controller';
import { slideFrames } from './navigation';
import { BarButton } from './ui';

/** Presenting: frames one by one in presentation order (slides, else every frame top to bottom). */
export function usePresentation(c: BoardController) {
  const [index, setIndex] = useState<number | null>(null);
  const frames = useCallback(() => {
    const { slides, others } = slideFrames(c);
    return slides.length ? slides : others;
  }, [c]);
  const show = useCallback(
    (i: number) => {
      const list = frames();
      const f = list[i];
      if (!f) return;
      setIndex(i);
      c.presenting = true;
      c.slide = f.id;
      c.select([]);
      c.showRect({ x: f.x, y: f.y, w: f.w, h: f.h }, { margin: 24, maxZoom: 8 });
    },
    [c, frames],
  );
  const start = useCallback(
    (frameId?: string) => {
      const list = frames();
      if (!list.length) return false;
      const at = frameId ? Math.max(0, list.findIndex((f) => f.id === frameId)) : 0;
      show(at);
      return true;
    },
    [frames, show],
  );
  const stop = useCallback(() => {
    setIndex(null);
    c.presenting = false;
    c.slide = null;
    c.changed();
  }, [c]);
  return { index, total: frames().length, start, stop, show, presenting: index !== null };
}

export function PresentControls({ presentation }: { presentation: ReturnType<typeof usePresentation> }) {
  const { t, format } = useI18n();
  const tp = t.weldboard.editor.present;
  const { index, total, show, stop } = presentation;
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        if (index < total - 1) show(index + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        if (index > 0) show(index - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        stop();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, total, show, stop]);
  if (index === null) return null;
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border bg-background p-1 shadow-lg">
      <BarButton label={tp.previous} onClick={() => show(index - 1)} disabled={index === 0}>
        <ChevronLeft />
      </BarButton>
      <span className="px-2 text-sm tabular-nums">{format(tp.slideOf, { n: index + 1, total })}</span>
      <BarButton label={tp.next} onClick={() => show(index + 1)} disabled={index >= total - 1}>
        <ChevronRight />
      </BarButton>
      <BarButton label={tp.stop} onClick={stop}>
        <X />
      </BarButton>
    </div>
  );
}
