import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { DisplayItem, ImageObject } from '@weldsuite/docs-engine';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { deleteImage, imageSize, patchImage, resizeImage, type SelectedImage } from './model/image-actions';

type ImageItem = Extract<DisplayItem, { kind: 'image' }>;

/**
 * The selected image's frame on its page: a corner handle to resize it
 * (keeping its proportions) and a small toolbar for wrapping, alt text,
 * the original size and deleting. Drawn in page points inside the page's
 * scaled layer; `ptPerPx` turns pointer movement back into points.
 */
export function ImageOverlay({ controller, item, target, ptPerPx }: { controller: DocController; item: ImageItem; target: SelectedImage; ptPerPx: number }) {
  const { t } = useI18n();
  const ti = t.welddocs.image;
  const [drag, setDrag] = useState<number | null>(null);
  const [alt, setAlt] = useState(target.image.alt ?? '');
  useEffect(() => setAlt(target.image.alt ?? ''), [target.image.alt, target.image.id]);
  const width = drag ?? item.width;
  const height = width * (item.height / item.width);
  const ro = controller.readOnly;

  const startResize = (e: React.PointerEvent) => {
    if (ro) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const move = (ev: PointerEvent) => setDrag(Math.max(8, item.width + (ev.clientX - startX) * ptPerPx));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      resizeImage(controller, target, item.width + (ev.clientX - startX) * ptPerPx);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const wraps: { key: NonNullable<ImageObject['wrap']>; label: string }[] = [
    { key: 'inline', label: ti.inline },
    { key: 'square', label: ti.square },
    { key: 'topBottom', label: ti.topBottom },
    { key: 'behind', label: ti.behind },
    { key: 'front', label: ti.front },
  ];
  const wrap = target.image.wrap ?? 'inline';

  return (
    <>
      <div
        className="pointer-events-none absolute border-2 border-blue-600"
        style={{ left: `${item.x}pt`, top: `${item.y}pt`, width: `${width}pt`, height: `${height}pt` }}
      />
      {!ro && (
        <div
          role="slider"
          aria-label={ti.resetSize}
          aria-valuenow={Math.round(width)}
          className="absolute size-2.5 cursor-nwse-resize border border-white bg-blue-600"
          style={{ left: `calc(${item.x + width}pt - 5px)`, top: `calc(${item.y + height}pt - 5px)` }}
          onPointerDown={startResize}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
      {!ro && (
        <div
          className="absolute z-10 flex origin-top-left items-center gap-1 rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-md"
          style={{ left: `${item.x}pt`, top: `calc(${item.y + height}pt + 6px)`, transform: `scale(${ptPerPx * (96 / 72)})` }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <select
            aria-label={ti.wrap}
            value={wrap}
            onChange={(e) => patchImage(controller, target, { wrap: e.target.value === 'inline' ? null : (e.target.value as ImageObject['wrap']) })}
            className="h-7 rounded border bg-background px-1"
          >
            {wraps.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
          <input
            aria-label={ti.altText}
            placeholder={ti.altPlaceholder}
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            onBlur={() => alt !== (target.image.alt ?? '') && patchImage(controller, target, { alt: alt.trim() || null })}
            className="h-7 w-44 rounded border bg-background px-1"
          />
          <button
            type="button"
            className="h-7 rounded px-2 hover:bg-accent"
            onClick={() =>
              void imageSize(target.image.src).then((size) => {
                if (size) patchImage(controller, target, { width: size.width * 0.75, height: size.height * 0.75 });
              })
            }
          >
            {ti.resetSize}
          </button>
          <button type="button" aria-label={ti.delete} className="flex h-7 w-7 items-center justify-center rounded hover:bg-accent" onClick={() => deleteImage(controller, target)}>
            <Trash2 className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}
