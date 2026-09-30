import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { Point } from './whiteboard-geometry';

interface ToolButtonProps {
  active: boolean;
  title: string;
  onSelect: () => void;
  icon: LucideIcon;
  buttonClassName?: string;
  iconClassName?: string;
}

/** Toolbar toggle: highlighted while its tool/option is the active one. */
export function ToolButton({
  active,
  title,
  onSelect,
  icon: Icon,
  buttonClassName = 'h-8 w-8 p-0',
  iconClassName = 'h-4 w-4',
}: ToolButtonProps) {
  return (
    <Button
      variant={active ? 'default' : 'ghost'}
      size="sm"
      className={buttonClassName}
      onClick={onSelect}
      title={title}
    >
      <Icon className={iconClassName} />
    </Button>
  );
}

const TOOL_CURSORS: Record<string, string> = {
  pan: 'grab',
  select: 'default',
  eraser: 'none',
};

/** CSS cursor for the canvas given the active tool. */
export function getCanvasCursor(isGrabbing: boolean, tool: string): string {
  if (isGrabbing) return 'grabbing';
  return TOOL_CURSORS[tool] ?? 'crosshair';
}

/**
 * Inline style for the canvas SVG. Uses translate3d during active interaction
 * for GPU-accelerated smooth performance, and regular translate when idle so
 * the browser re-rasterizes the SVG at the correct zoom resolution.
 */
export function getCanvasSvgStyle(isInteracting: boolean, pan: Point, zoom: number): CSSProperties {
  return {
    overflow: 'visible',
    transform: isInteracting
      ? `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`
      : `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transformOrigin: '0 0',
    willChange: isInteracting ? 'transform' : 'auto',
    transition: 'none',
  };
}

interface EraserPreviewProps {
  x: number;
  y: number;
  size: number;
  isErasing: boolean;
}

/** Ring showing the eraser's size and position on the canvas. */
export function EraserPreview({ x, y, size, isErasing }: EraserPreviewProps) {
  return (
    <g pointerEvents="none">
      <circle
        cx={x}
        cy={y}
        r={size}
        fill="none"
        stroke={isErasing ? '#ff0000' : '#ff6464'}
        strokeWidth={isErasing ? 3 : 2}
        strokeDasharray={isErasing ? 'none' : '4,2'}
        opacity={isErasing ? 1 : 0.8}
      />
      {/* Inner guide circle to show it's a ring */}
      {!isErasing && (
        <circle
          cx={x}
          cy={y}
          r={Math.max(1, size - 3)}
          fill="none"
          stroke="#ff6464"
          strokeWidth={1}
          strokeDasharray="2,2"
          opacity={0.4}
        />
      )}
    </g>
  );
}
