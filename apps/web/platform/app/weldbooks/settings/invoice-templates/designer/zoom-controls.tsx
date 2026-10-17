import { Maximize, Minus, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { MOD_KEY } from './top-bar';

interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

/** Zoom in, zoom out and fit, stacked in the bottom-right corner of the canvas like the workflow canvas controls. */
export function ZoomControls({ onZoomIn, onZoomOut, onFit, canZoomIn, canZoomOut }: Readonly<ZoomControlsProps>) {
  const { t } = useI18n();
  const td = t.accounting.invoiceTemplates.designer;
  const button =
    'w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors outline-none focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40';

  return (
    <div
      role="group"
      aria-label={td.zoom}
      className="absolute bottom-4 right-4 z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-white dark:bg-background"
    >
      <button type="button" onClick={onZoomIn} disabled={!canZoomIn} className={button} title={`${td.zoomIn} (${MOD_KEY}+)`} aria-label={td.zoomIn}>
        <Plus className="h-4 w-4 text-foreground" />
      </button>
      <div className="border-t border-border" />
      <button type="button" onClick={onZoomOut} disabled={!canZoomOut} className={button} title={`${td.zoomOut} (${MOD_KEY}-)`} aria-label={td.zoomOut}>
        <Minus className="h-4 w-4 text-foreground" />
      </button>
      <div className="border-t border-border" />
      <button type="button" onClick={onFit} className={button} title={`${td.zoomFit} (${MOD_KEY}0)`} aria-label={td.zoomFit}>
        <Maximize className="h-4 w-4 text-foreground" />
      </button>
    </div>
  );
}
