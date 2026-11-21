/**
 * Zoom in / zoom out / fit buttons in one bordered column, as in the corner of
 * the workflow canvas (WeldCRM, WeldConnect) and the world map. The caller
 * places it; the buttons only report the click. No text of its own: the
 * names come in `labels`.
 */

import { Maximize, Minus, Plus } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ZoomControlsLabels {
  zoomIn: string;
  zoomOut: string;
  /** Fit everything in view again ("Reset layout", "Show the whole world"). */
  reset: string;
}

export interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  labels: ZoomControlsLabels;
  className?: string;
}

const BUTTON = 'w-9 h-9 flex items-center justify-center hover:bg-muted transition-colors';

export function ZoomControls({ onZoomIn, onZoomOut, onReset, labels, className }: Readonly<ZoomControlsProps>) {
  return (
    <div className={cn('flex flex-col bg-white dark:bg-background border border-border rounded-lg overflow-hidden', className)}>
      <button type="button" onClick={onZoomIn} className={BUTTON} title={labels.zoomIn} aria-label={labels.zoomIn}>
        <Plus className="w-4 h-4 text-foreground" />
      </button>
      <div className="border-t border-border" />
      <button type="button" onClick={onZoomOut} className={BUTTON} title={labels.zoomOut} aria-label={labels.zoomOut}>
        <Minus className="w-4 h-4 text-foreground" />
      </button>
      <div className="border-t border-border" />
      <button type="button" onClick={onReset} className={BUTTON} title={labels.reset} aria-label={labels.reset}>
        <Maximize className="w-4 h-4 text-foreground" />
      </button>
    </div>
  );
}
