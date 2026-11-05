import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BoardElement, Crop } from '@weldsuite/board-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardController } from './model/board-controller';
import { croppedHeight, dragCrop, FULL_CROP, type CropHandle } from './model/crop';

const VIEW = 520;

type Drag = { kind: CropHandle; x: number; y: number; start: Crop };

/**
 * Crops an image element: the whole image with the kept part framed. The
 * element keeps its width and takes the kept part's proportions, so the
 * picture is not stretched.
 */
export function CropDialog({ controller: c, element, loadImage, onClose }: {
  controller: BoardController;
  element: BoardElement | null;
  loadImage: (src: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.crop;
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<Crop>(FULL_CROP);
  const drag = useRef<Drag | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setUrl(null);
    setNatural(null);
    setCrop(element?.crop ?? FULL_CROP);
    if (!element?.src) return;
    let alive = true;
    void loadImage(element.src).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [element, loadImage]);

  const scale = natural ? Math.min(VIEW / natural.w, (VIEW * 0.75) / natural.h, 1.5) : 1;
  const shown = natural ? { w: natural.w * scale, h: natural.h * scale } : { w: VIEW, h: VIEW * 0.6 };

  const begin = (kind: CropHandle) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, start: crop };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setCrop(dragCrop(d.start, d.kind, (e.clientX - d.x) / shown.w, (e.clientY - d.y) / shown.h));
  };
  const end = () => {
    drag.current = null;
  };

  const apply = (next: Crop | null) => {
    if (!element || !natural) return;
    const kept = next ?? FULL_CROP;
    const full = kept.w >= 0.999 && kept.h >= 0.999;
    c.apply({ type: 'set', id: element.id, patch: { crop: full ? null : round(kept), h: croppedHeight(element.w, kept, natural) } });
    onClose();
  };

  const handle = (kind: Exclude<CropHandle, 'move'>, cls: string) => (
    <div
      role="presentation"
      onPointerDown={begin(kind)}
      className={`absolute size-3 rounded-sm border-2 border-white bg-primary shadow ${cls}`}
      style={{ cursor: kind === 'nw' || kind === 'se' ? 'nwse-resize' : 'nesw-resize' }}
    />
  );

  return (
    <Dialog open={!!element} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{tc.title}</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center py-2">
          <div ref={box} className="relative select-none overflow-hidden rounded bg-muted" style={{ width: shown.w, height: shown.h }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
            {url ? (
              <img
                src={url}
                alt={element?.alt ?? ''}
                draggable={false}
                className="absolute inset-0 size-full"
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
              />
            ) : (
              <div className="flex size-full items-center justify-center">
                <InlineSpinner />
              </div>
            )}
            {natural && (
              <div
                role="presentation"
                aria-label={tc.area}
                onPointerDown={begin('move')}
                className="absolute cursor-move border-2 border-primary"
                style={{
                  left: crop.x * shown.w,
                  top: crop.y * shown.h,
                  width: crop.w * shown.w,
                  height: crop.h * shown.h,
                  boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.55)',
                }}
              >
                {handle('nw', '-left-1.5 -top-1.5')}
                {handle('ne', '-right-1.5 -top-1.5')}
                {handle('sw', '-bottom-1.5 -left-1.5')}
                {handle('se', '-bottom-1.5 -right-1.5')}
              </div>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" disabled={!natural} onClick={() => apply(null)}>
            {tc.reset}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {tc.cancel}
            </Button>
            <Button disabled={!natural} onClick={() => apply(crop)}>
              {tc.apply}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function round(c: Crop): Crop {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) };
}
