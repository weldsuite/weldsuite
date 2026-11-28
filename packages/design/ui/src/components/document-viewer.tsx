import { useCallback, useEffect, useId, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Maximize, Minus, Plus, RotateCw } from 'lucide-react';

import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';

/** What the toolbar says. The component holds no text of its own. */
export interface DocumentViewerLabels {
  zoomIn: string;
  zoomOut: string;
  /** Back to the whole page in view (100%, upright). */
  fit: string;
  rotate: string;
  previousPage: string;
  nextPage: string;
  /** Names the page number field. */
  page: string;
  /** Names the toolbar. */
  toolbar: string;
  /** Names the area the document shows in. */
  document: string;
  /** The link under a document that cannot be shown in place. */
  open: string;
  /** Shown when the file cannot be displayed. */
  failed: string;
  /** `"of {count}"`, after the page field; only shown with `pageCount`. */
  pageOf?: string;
}

export type DocumentViewerKind = 'pdf' | 'image';

export interface DocumentViewerProps {
  /** The file's address (a private-file URL the browser may open). */
  src: string;
  /** What the file is; read from `mimeType` or the file name when left out. */
  kind?: DocumentViewerKind;
  mimeType?: string | null;
  fileName?: string | null;
  /** Total pages of a PDF, when known; the next-page button stops at the last. */
  pageCount?: number;
  labels: DocumentViewerLabels;
  className?: string;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;

/** Image formats browsers show in an `<img>`; anything else with a type is taken as a PDF. */
export function documentKind(file: { mimeType?: string | null; fileName?: string | null }): DocumentViewerKind {
  if (file.mimeType) return file.mimeType.startsWith('image/') ? 'image' : 'pdf';
  return /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(file.fileName ?? '') ? 'image' : 'pdf';
}

/** The next zoom level, one step in `direction`, kept inside the limits. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = Math.round((zoom + direction * ZOOM_STEP) * 100) / 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

type Shortcut = 'zoomIn' | 'zoomOut' | 'reset' | 'rotate';

/** What a key does in the viewer's area, or null for the keys it leaves alone. */
function shortcutFor(key: string): Shortcut | null {
  switch (key) {
    case '+':
    case '=':
      return 'zoomIn';
    case '-':
      return 'zoomOut';
    case '0':
      return 'reset';
    case 'r':
    case 'R':
      return 'rotate';
    default:
      return null;
  }
}

/** The page is laid out zoom times as large as the area, so the area scrolls; a quarter turn swaps the sides. */
function mediaStyleFor(type: DocumentViewerKind, turns: number) {
  const quarter = turns % 2 === 1;
  const sizes =
    type === 'pdf'
      ? { width: quarter ? '100cqh' : '100cqw', height: quarter ? '100cqw' : '100cqh' }
      : { maxWidth: quarter ? '100cqh' : '100cqw', maxHeight: quarter ? '100cqw' : '100cqh' };
  return { rotate: `${turns * 90}deg`, translate: '-50% -50%', ...sizes };
}

function PageControls({
  idPrefix,
  page,
  lastPage,
  pageCount,
  labels,
  goToPage,
}: Readonly<{
  idPrefix: string;
  page: number;
  lastPage: number;
  pageCount?: number;
  labels: DocumentViewerLabels;
  goToPage: (next: number) => void;
}>) {
  return (
    <div className="ml-auto flex items-center gap-1">
      <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => goToPage(page - 1)} disabled={page <= 1} aria-label={labels.previousPage} title={labels.previousPage}>
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
      <label htmlFor={`${idPrefix}-page`} className="sr-only">
        {labels.page}
      </label>
      <input
        id={`${idPrefix}-page`}
        type="number"
        inputMode="numeric"
        min={1}
        max={Number.isFinite(lastPage) ? lastPage : undefined}
        value={page}
        onChange={(event) => goToPage(Number(event.target.value))}
        className="h-8 w-12 rounded-md border bg-background px-1 text-center text-sm tabular-nums"
      />
      {pageCount && labels.pageOf ? (
        <span className="text-xs text-muted-foreground tabular-nums">{labels.pageOf.replace('{count}', String(pageCount))}</span>
      ) : null}
      <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => goToPage(page + 1)} disabled={page >= lastPage} aria-label={labels.nextPage} title={labels.nextPage}>
        <ChevronRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

function FailedNotice({ src, labels }: Readonly<{ src: string; labels: DocumentViewerLabels }>) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <p>{labels.failed}</p>
      <Button variant="link" asChild className="h-auto p-0">
        <a href={src} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="size-4" aria-hidden />
          {labels.open}
        </a>
      </Button>
    </div>
  );
}

function DocumentMedia({
  type,
  src,
  pdfSrc,
  page,
  title,
  style,
  onError,
}: Readonly<{
  type: DocumentViewerKind;
  src: string;
  pdfSrc: string;
  page: number;
  title: string;
  style: React.CSSProperties;
  onError: () => void;
}>) {
  if (type === 'pdf') {
    return <iframe key={`${src}#${page}`} src={pdfSrc} title={title} className="absolute left-1/2 top-1/2 border-0 bg-background" style={style} onError={onError} />;
  }
  return <img src={src} alt={title} className="absolute left-1/2 top-1/2 bg-background object-contain" style={style} onError={onError} />;
}

/**
 * A scanned or uploaded document next to a form: a PDF (the browser's own
 * viewer, opened at a page) or an image, with zoom, rotate and, for a PDF,
 * page buttons. The area scrolls when zoomed in, takes `+`, `-`, `0` and `r`
 * from the keyboard when focused, and falls back to an "open" link when the
 * file cannot be shown. It holds no translations: every word comes from
 * `labels`.
 */
export function DocumentViewer({
  src,
  kind,
  mimeType,
  fileName,
  pageCount,
  labels,
  className,
}: Readonly<DocumentViewerProps>) {
  const ids = useId();
  const type = kind ?? documentKind({ mimeType, fileName });
  const [zoom, setZoom] = useState(1);
  const [turns, setTurns] = useState(0);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);

  // A different file starts from the top, upright and whole again.
  useEffect(() => {
    setZoom(1);
    setTurns(0);
    setPage(1);
    setFailed(false);
  }, [src]);

  const lastPage = pageCount && pageCount > 0 ? pageCount : Number.POSITIVE_INFINITY;
  const goToPage = useCallback((next: number) => setPage(Math.min(lastPage, Math.max(1, Math.trunc(next) || 1))), [lastPage]);
  const reset = useCallback(() => {
    setZoom(1);
    setTurns(0);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const shortcut = shortcutFor(event.key);
    if (!shortcut) return;
    if (shortcut === 'zoomIn') setZoom((z) => stepZoom(z, 1));
    else if (shortcut === 'zoomOut') setZoom((z) => stepZoom(z, -1));
    else if (shortcut === 'reset') reset();
    else setTurns((t) => (t + 1) % 4);
    event.preventDefault();
  };

  const percent = Math.round(zoom * 100);
  const mediaStyle = mediaStyleFor(type, turns);
  const pdfSrc = `${src}${src.includes('#') ? '&' : '#'}page=${page}&toolbar=0&navpanes=0`;

  return (
    <div data-slot="document-viewer" className={cn('flex flex-col overflow-hidden rounded-lg border bg-muted/30', className)}>
      <div role="toolbar" aria-label={labels.toolbar} className="flex flex-wrap items-center gap-1 border-b bg-background px-2 py-1.5">
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setZoom((z) => stepZoom(z, -1))} disabled={zoom <= MIN_ZOOM} aria-label={labels.zoomOut} title={labels.zoomOut}>
          <Minus className="size-4" aria-hidden />
        </Button>
        <output className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-live="off">
          {percent}%
        </output>
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setZoom((z) => stepZoom(z, 1))} disabled={zoom >= MAX_ZOOM} aria-label={labels.zoomIn} title={labels.zoomIn}>
          <Plus className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={reset} aria-label={labels.fit} title={labels.fit}>
          <Maximize className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setTurns((t) => (t + 1) % 4)} aria-label={labels.rotate} title={labels.rotate}>
          <RotateCw className="size-4" aria-hidden />
        </Button>

        {type === 'pdf' ? (
          <PageControls idPrefix={ids} page={page} lastPage={lastPage} pageCount={pageCount} labels={labels} goToPage={goToPage} />
        ) : (
          <span className="ml-auto" />
        )}
        <Button type="button" variant="ghost" size="icon" className="size-8" asChild>
          <a href={src} target="_blank" rel="noopener noreferrer" aria-label={labels.open} title={labels.open}>
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </Button>
      </div>

      {/*
        The scroll area is focusable on purpose: a zoomed document must be scrollable by keyboard (scrollable
        regions have to take focus), and the zoom and rotate keys work while it has it.
      */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a focusable scroll region that takes the viewer's shortcut keys */}
      <div
        role="region"
        aria-label={labels.document}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard users scroll a zoomed document from here
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="h-[var(--document-viewer-height,min(78vh,60rem))] flex-none overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {failed ? (
          <FailedNotice src={src} labels={labels} />
        ) : (
          <div className="relative [container-type:size]" style={{ width: `${percent}%`, height: `${percent}%` }} data-testid="document-sheet">
            <DocumentMedia type={type} src={src} pdfSrc={pdfSrc} page={page} title={labels.document} style={mediaStyle} onError={() => setFailed(true)} />
          </div>
        )}
      </div>
    </div>
  );
}
