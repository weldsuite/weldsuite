import type { CSSProperties, MouseEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type {
  BoundingBox,
  ConnectionPointName,
  ConnectionPoints,
  CornerHandle,
  Point,
  ResizeHandle,
} from './whiteboard-geometry';

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
}: Readonly<ToolButtonProps>) {
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
export function EraserPreview({ x, y, size, isErasing }: Readonly<EraserPreviewProps>) {
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

/**
 * Focus a text field and put the caret at the end of its text. Meant for an
 * inline ref callback (`ref={(el) => focusTextareaAtEnd(el)}`) so it re-runs on
 * every render and pulls focus back after, say, a toolbar click.
 */
export function focusTextareaAtEnd(textarea: HTMLTextAreaElement | null): void {
  if (textarea && document.activeElement !== textarea) {
    // Use setTimeout to ensure React has finished rendering
    setTimeout(() => {
      textarea.focus();
      // Move cursor to end of text
      const len = textarea.value?.length || 0;
      textarea.setSelectionRange(len, len);
    }, 0);
  }
}

const CONNECTION_POINT_NAMES: readonly ConnectionPointName[] = ['top', 'right', 'bottom', 'left'];

interface ConnectionHoverPointsProps {
  points: ConnectionPoints;
  snappedPoint: ConnectionPointName | null;
}

/** Connection points shown on an element while an arrow is being dragged over it. */
export function ConnectionHoverPoints({ points, snappedPoint }: Readonly<ConnectionHoverPointsProps>) {
  return (
    <>
      {CONNECTION_POINT_NAMES.map(name => (
        <circle
          key={name}
          cx={points[name].x}
          cy={points[name].y}
          r={snappedPoint === name ? 10 : 6}
          fill={snappedPoint === name ? '#22c55e' : '#3b82f6'}
          stroke="white"
          strokeWidth={2}
          className="cursor-crosshair"
          style={{ pointerEvents: 'none' }}
        />
      ))}
    </>
  );
}

interface ConnectionHandlesProps {
  points: ConnectionPoints;
  /** Start dragging a new connection from the named point at `position`. */
  onStart: (name: ConnectionPointName, position: Point) => void;
  /**
   * Text elements reposition their points in the DOM after measuring, so the
   * live position is read off the circle instead of taken from `points`.
   */
  isTextElement?: boolean;
}

/** Draggable connection points of a selected element. */
export function ConnectionHandles({ points, onStart, isTextElement = false }: Readonly<ConnectionHandlesProps>) {
  return (
    <>
      {CONNECTION_POINT_NAMES.map(name => (
        <circle
          key={name}
          cx={points[name].x}
          cy={points[name].y}
          r={5}
          fill="#3b82f6"
          stroke="white"
          strokeWidth={2}
          className={isTextElement ? 'cursor-crosshair text-connection-point' : 'cursor-crosshair'}
          style={{ pointerEvents: 'all' }}
          onMouseDown={(e) => {
            e.stopPropagation();
            if (!isTextElement) {
              onStart(name, points[name]);
              return;
            }
            const circle = e.currentTarget;
            const cx = Number.parseFloat(circle.getAttribute('cx') || '0');
            const cy = Number.parseFloat(circle.getAttribute('cy') || '0');
            onStart(name, { x: cx, y: cy });
          }}
        />
      ))}
    </>
  );
}

interface ResizeHandlesProps {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Tag each handle with `data-handle` so the canvas mouse-down can find it. */
  tagged?: boolean;
}

const RESIZE_HANDLE_CURSORS = {
  nw: 'cursor-nw-resize',
  ne: 'cursor-ne-resize',
  sw: 'cursor-sw-resize',
  se: 'cursor-se-resize',
} as const;

/** Corner resize handles around a selected element's bounds. */
export function ResizeHandles({ left, top, right, bottom, tagged = true }: Readonly<ResizeHandlesProps>) {
  const corners: { handle: ResizeHandle; cx: number; cy: number }[] = [
    { handle: 'nw', cx: left, cy: top },
    { handle: 'ne', cx: right, cy: top },
    { handle: 'sw', cx: left, cy: bottom },
    { handle: 'se', cx: right, cy: bottom },
  ];
  return (
    <>
      {corners.map(({ handle, cx, cy }) => (
        <circle
          key={handle}
          cx={cx}
          cy={cy}
          r={6}
          fill="white"
          stroke="#3b82f6"
          strokeWidth={2}
          className={RESIZE_HANDLE_CURSORS[handle]}
          style={{ pointerEvents: 'all' }}
          data-handle={tagged ? handle : undefined}
        />
      ))}
    </>
  );
}

interface CornerRadiusHandlesProps {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  onDragStart: (corner: CornerHandle, e: MouseEvent<SVGCircleElement>) => void;
}

/** Handles just inside a rectangle's corners that drag its border radius. */
export function CornerRadiusHandles({ x, y, width, height, radius, onDragStart }: Readonly<CornerRadiusHandlesProps>) {
  const offset = Math.max(12, radius + 6); // Position based on current radius
  const corners: { corner: CornerHandle; cx: number; cy: number }[] = [
    { corner: 'tl', cx: x + offset, cy: y + offset },
    { corner: 'tr', cx: x + width - offset, cy: y + offset },
    { corner: 'bl', cx: x + offset, cy: y + height - offset },
    { corner: 'br', cx: x + width - offset, cy: y + height - offset },
  ];
  return (
    <>
      {corners.map(({ corner, cx, cy }) => (
        <circle
          key={corner}
          cx={cx}
          cy={cy}
          r={5}
          fill="#3b82f6"
          stroke="white"
          strokeWidth={2}
          className="cursor-pointer"
          style={{ pointerEvents: 'all' }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onDragStart(corner, e);
          }}
        />
      ))}
    </>
  );
}

/** Position and size an SVG rect to `bbox` grown by `padX`/`padY` on each side. */
export function setPaddedBounds(rect: SVGRectElement, bbox: BoundingBox, padX: number, padY: number): void {
  rect.setAttribute('x', String(bbox.x - padX));
  rect.setAttribute('y', String(bbox.y - padY));
  rect.setAttribute('width', String(bbox.width + padX * 2));
  rect.setAttribute('height', String(bbox.height + padY * 2));
}

/** Whether two bounding boxes match exactly (a missing box never matches). */
export function areBoundsEqual(a: BoundingBox | null | undefined, b: BoundingBox): boolean {
  return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Move the four `.text-connection-point` circles under `container` (top,
 * right, bottom, left) to sit around the measured text bounds.
 */
export function positionTextConnectionPoints(container: Element | null, bbox: BoundingBox): void {
  const connPoints = container?.querySelectorAll('.text-connection-point');
  if (connPoints?.length !== 4) return;

  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const positions = [
    { cx: centerX, cy: bbox.y - 4 }, // Top
    { cx: bbox.x + bbox.width + 6, cy: centerY }, // Right
    { cx: centerX, cy: bbox.y + bbox.height + 4 }, // Bottom
    { cx: bbox.x - 6, cy: centerY }, // Left
  ];
  positions.forEach(({ cx, cy }, index) => {
    connPoints[index].setAttribute('cx', String(cx));
    connPoints[index].setAttribute('cy', String(cy));
  });
}

/** SVG `text-anchor` for a text element's alignment. */
export function getTextAnchor(align: 'left' | 'center' | 'right' | undefined): 'start' | 'middle' | 'end' {
  if (align === 'center') return 'middle';
  if (align === 'right') return 'end';
  return 'start';
}
