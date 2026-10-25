import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

interface PdfPageProps {
  pdf: PDFDocumentProxy | null;
  /** Zero-based. */
  pageIndex: number;
  /** Page size in PDF points as displayed; the box takes its shape from it before pdf.js has drawn anything. */
  size: { width: number; height: number };
  /** Called with CSS pixels per PDF point, so the field layer can scale with the page. */
  children?: (scale: number) => ReactNode;
  label: string;
}

/** Cap on canvas pixels, so a long PDF cannot exhaust a phone's memory. */
const MAX_CANVAS_PIXELS = 12_000_000;

/**
 * One PDF page, filling the width of its column. It is only drawn once it is
 * near the viewport (long documents stay light) and redrawn after a resize.
 */
export function PdfPage({ pdf, pageIndex, size, children, label }: Readonly<PdfPageProps>) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const resize = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    resize.observe(box);
    const visibility = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: '900px 0px' });
    visibility.observe(box);
    return () => {
      resize.disconnect();
      visibility.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!pdf || !near || width <= 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    // Wait for a resize to settle; the first draw is immediate.
    const timer = window.setTimeout(
      () => {
        void (async () => {
          try {
            const page = await pdf.getPage(pageIndex + 1);
            if (cancelled) return;
            const natural = page.getViewport({ scale: 1 });
            const cssScale = width / natural.width;
            const viewport = page.getViewport({ scale: cssScale });
            let ratio = Math.min(window.devicePixelRatio || 1, 3);
            const pixels = viewport.width * viewport.height * ratio * ratio;
            if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
            // Draw off-screen and copy over, so a resize never shows a blank page.
            const off = document.createElement('canvas');
            off.width = Math.max(1, Math.floor(viewport.width * ratio));
            off.height = Math.max(1, Math.floor(viewport.height * ratio));
            task = page.render({ canvas: off, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
            await task.promise;
            const canvas = canvasRef.current;
            if (cancelled || !canvas) return;
            canvas.width = off.width;
            canvas.height = off.height;
            canvas.getContext('2d')?.drawImage(off, 0, 0);
            setDrawn(true);
          } catch {
            // A newer render cancelled this one, or the page could not be drawn;
            // the white page and the fields stay usable either way.
          }
        })();
      },
      drawn ? 200 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
    // `drawn` only picks the debounce; it must not retrigger a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageIndex, near, width]);

  const scale = width > 0 ? width / size.width : 0;
  return (
    <div
      ref={boxRef}
      className="relative w-full bg-white shadow-sm ring-1 ring-black/10"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      data-page-index={pageIndex}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0 size-full" style={{ opacity: drawn ? 1 : 0 }} />
      {scale > 0 ? children?.(scale) : null}
    </div>
  );
}
