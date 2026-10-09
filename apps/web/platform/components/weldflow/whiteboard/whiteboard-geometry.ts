// Pure geometry / hit-testing helpers for the whiteboard. Nothing in here
// touches React state, so each function can be reasoned about (and tested) on
// its own; `whiteboard-view.tsx` wires them to its state and event handlers.

export type ArrowType = 'line' | 'arrow' | 'elbow';

export interface Point {
  x: number;
  y: number;
}

export interface ErasedStroke {
  points: Point[];
  size: number;
}

export interface WhiteboardElement {
  id: string;
  type: 'rectangle' | 'circle' | 'text' | 'sticky' | 'path' | 'arrow';
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number; // Legacy: for backwards compatibility with old circles
  radiusX?: number; // For ellipse horizontal radius
  radiusY?: number; // For ellipse vertical radius
  text?: string;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  points?: Point[];
  fontSize?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textDecoration?: 'none' | 'underline';
  textAlign?: 'left' | 'center' | 'right';
  link?: string;
  locked?: boolean;
  endX?: number;
  endY?: number;
  erasedPaths?: ErasedStroke[];
  arrowType?: ArrowType;
  // Connection properties - which elements this arrow connects
  startElementId?: string;
  startConnectionPoint?: 'top' | 'right' | 'bottom' | 'left';
  endElementId?: string;
  endConnectionPoint?: 'top' | 'right' | 'bottom' | 'left';
  // Custom curve control point offset (for manual curve adjustment)
  curveControlX?: number;
  curveControlY?: number;
  // Border radius for rectangles
  borderRadius?: number;
}

export type ConnectionPointName = 'top' | 'right' | 'bottom' | 'left';

export type ConnectionPoints = Record<ConnectionPointName, Point>;

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

export type CornerHandle = 'tl' | 'tr' | 'bl' | 'br';

export type ArrowHandle = 'start' | 'end' | 'curve';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/** Snapshot of an element's geometry taken when a drag begins. */
export interface DragStart {
  x: number;
  y: number;
  endX?: number;
  endY?: number;
  points?: Point[];
}

export interface CornerRadiusDragStart {
  x: number;
  y: number;
  initialRadius: number;
}

const CONNECTION_POINT_NAMES: ConnectionPointName[] = ['top', 'right', 'bottom', 'left'];

const MIN_RESIZE_SIZE = 10;

function distanceBetween(a: Point, b: Point): number {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

/** Ellipse radii, honouring the legacy single `radius` field. */
export function getEllipseRadii(element: WhiteboardElement): { rx: number; ry: number } {
  return {
    rx: element.radiusX ?? element.radius ?? 50,
    ry: element.radiusY ?? element.radius ?? 50,
  };
}

/** Estimated (unmeasured) width of a text element. */
function estimateTextWidth(element: WhiteboardElement): number {
  return (element.text?.length || 0) * (element.fontSize || 16) * 0.6;
}

// ---------------------------------------------------------------------------
// Distances and segment intersection
// ---------------------------------------------------------------------------

/** Distance from a point to a line segment. */
export function pointToLineDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const A = point.x - lineStart.x;
  const B = point.y - lineStart.y;
  const C = lineEnd.x - lineStart.x;
  const D = lineEnd.y - lineStart.y;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;

  if (lenSq !== 0) {
    param = dot / lenSq;
  }

  let xx, yy;

  if (param < 0) {
    xx = lineStart.x;
    yy = lineStart.y;
  } else if (param > 1) {
    xx = lineEnd.x;
    yy = lineEnd.y;
  } else {
    xx = lineStart.x + param * C;
    yy = lineStart.y + param * D;
  }

  const dx = point.x - xx;
  const dy = point.y - yy;

  return Math.hypot(dx, dy);
}

/**
 * Strict segment-vs-segment intersection (excludes collinear/endpoint-only
 * touches). Used to test if a line-shaped element actually crosses the
 * marquee — bounding-box overlap alone gives false positives for diagonals.
 */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** True when the segment a→b crosses any of the four sides of the bounds. */
function segmentCrossesBounds(a: Point, b: Point, bounds: Bounds): boolean {
  const { minX, maxX, minY, maxY } = bounds;
  return (
    segmentsIntersect(a, b, { x: minX, y: minY }, { x: maxX, y: minY }) || // top edge
    segmentsIntersect(a, b, { x: maxX, y: minY }, { x: maxX, y: maxY }) || // right edge
    segmentsIntersect(a, b, { x: maxX, y: maxY }, { x: minX, y: maxY }) || // bottom edge
    segmentsIntersect(a, b, { x: minX, y: maxY }, { x: minX, y: minY })    // left edge
  );
}

function isPointInBounds(x: number, y: number, bounds: Bounds): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

// ---------------------------------------------------------------------------
// Selection box (marquee)
// ---------------------------------------------------------------------------

function rectangleOverlapsBounds(element: WhiteboardElement, bounds: Bounds): boolean {
  // Check if rectangles intersect (not just contained)
  return !(element.x! + element.width! < bounds.minX ||
          element.x! > bounds.maxX ||
          element.y! + element.height! < bounds.minY ||
          element.y! > bounds.maxY);
}

function ellipseOverlapsBounds(element: WhiteboardElement, bounds: Bounds): boolean {
  // Simple bounding box intersection for ellipse
  const { rx, ry } = getEllipseRadii(element);
  return !(element.x + rx < bounds.minX ||
          element.x - rx > bounds.maxX ||
          element.y + ry < bounds.minY ||
          element.y - ry > bounds.maxY);
}

function textOverlapsBounds(element: WhiteboardElement, bounds: Bounds): boolean {
  const textWidth = estimateTextWidth(element);
  const textHeight = element.fontSize || 16;
  return !(element.x + textWidth < bounds.minX ||
          element.x > bounds.maxX ||
          element.y < bounds.minY ||
          element.y - textHeight > bounds.maxY);
}

function arrowOverlapsBounds(element: WhiteboardElement, bounds: Bounds): boolean {
  // The line is selected only if its endpoints are inside the marquee
  // OR the actual segment crosses one of the marquee sides — not just
  // if the segment's bounding box overlaps the marquee (which would
  // false-positive for long diagonals).
  const startInBox = isPointInBounds(element.x, element.y, bounds);
  const endInBox = isPointInBounds(element.endX!, element.endY!, bounds);
  if (startInBox || endInBox) return true;
  return segmentCrossesBounds(
    { x: element.x, y: element.y },
    { x: element.endX!, y: element.endY! },
    bounds
  );
}

function pathOverlapsBounds(element: WhiteboardElement, bounds: Bounds): boolean {
  const points = element.points;
  if (!points || points.length === 0) return false;
  // A point inside the marquee selects the path. Otherwise, check
  // whether any segment of the stroke crosses a marquee side so a
  // marquee drawn over the path's middle still selects it.
  if (points.some(p => isPointInBounds(p.x, p.y, bounds))) return true;
  for (let i = 0; i < points.length - 1; i++) {
    if (segmentCrossesBounds(points[i], points[i + 1], bounds)) return true;
  }
  return false;
}

/** Check if an element intersects with the selection box (partial selection). */
export function isElementInSelectionBox(element: WhiteboardElement, box: SelectionBox | null): boolean {
  if (!box) return false;

  const bounds: Bounds = {
    minX: Math.min(box.startX, box.endX),
    maxX: Math.max(box.startX, box.endX),
    minY: Math.min(box.startY, box.endY),
    maxY: Math.max(box.startY, box.endY),
  };

  switch (element.type) {
    case 'rectangle':
    case 'sticky':
      return rectangleOverlapsBounds(element, bounds);
    case 'circle':
      return ellipseOverlapsBounds(element, bounds);
    case 'text':
      return textOverlapsBounds(element, bounds);
    case 'arrow':
      return arrowOverlapsBounds(element, bounds);
    case 'path':
      return pathOverlapsBounds(element, bounds);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Click hit-testing
// ---------------------------------------------------------------------------

/**
 * Distance from `point` to the segment a→b, or null when the segment has no
 * length (nothing to hit).
 */
function distanceToSegmentOrNull(point: Point, a: Point, b: Point): number | null {
  const length = Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
  if (length === 0) return null;
  const t = Math.max(0, Math.min(1, (
    (point.x - a.x) * (b.x - a.x) +
    (point.y - a.y) * (b.y - a.y)
  ) / (length * length)));
  const projX = a.x + t * (b.x - a.x);
  const projY = a.y + t * (b.y - a.y);
  return Math.sqrt(Math.pow(point.x - projX, 2) + Math.pow(point.y - projY, 2));
}

function hitTestArrow(el: WhiteboardElement, point: Point, hitTolerance: number): boolean {
  // Check proximity to the arrow line.
  const distToLine = distanceToSegmentOrNull(
    point,
    { x: el.x, y: el.y },
    { x: el.endX || el.x, y: el.endY || el.y }
  );
  return distToLine !== null && distToLine <= hitTolerance;
}

function hitTestPath(el: WhiteboardElement, point: Point, hitTolerance: number): boolean {
  if (!el.points || el.points.length < 2) return false;
  // Check proximity to any segment of the path.
  for (let i = 0; i < el.points.length - 1; i++) {
    const segDist = distanceToSegmentOrNull(point, el.points[i], el.points[i + 1]);
    if (segDist !== null && segDist <= hitTolerance) return true;
  }
  return false;
}

/**
 * Whether `point` (canvas coordinates) falls on the element. Lines (arrows and
 * freehand paths) are hit within `lineTolerance`, which by default scales with
 * zoom so the clickable strip stays ~12px wide on screen at any zoom level.
 */
export function hitTestElement(
  el: WhiteboardElement,
  point: Point,
  zoom: number,
  lineTolerance: number = 12 / zoom
): boolean {
  switch (el.type) {
    case 'rectangle':
    case 'sticky':
      return point.x >= el.x! && point.x <= el.x! + el.width! &&
             point.y >= el.y! && point.y <= el.y! + el.height!;
    case 'circle': {
      // Support ellipse with radiusX/radiusY or legacy radius
      const { rx, ry } = getEllipseRadii(el);
      // Ellipse equation: (x-cx)^2/rx^2 + (y-cy)^2/ry^2 <= 1
      const normalizedDist = Math.pow(point.x - el.x, 2) / (rx * rx) + Math.pow(point.y - el.y, 2) / (ry * ry);
      return normalizedDist <= 1;
    }
    case 'text': {
      // Use minimum width for empty text to make it clickable
      const textWidth = Math.max(100, estimateTextWidth(el));
      const textHeight = (el.fontSize || 16) * 1.5;
      return point.x >= el.x && point.x <= el.x + textWidth &&
             point.y >= el.y - textHeight && point.y <= el.y;
    }
    case 'arrow':
      return hitTestArrow(el, point, lineTolerance);
    case 'path':
      return hitTestPath(el, point, lineTolerance);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Resize and arrow handles (mouse down)
// ---------------------------------------------------------------------------

/** Bounding box as displayed (sticky height auto-grows with its text). */
function getResizeBox(element: WhiteboardElement): BoundingBox {
  if (element.type === 'sticky') {
    const textLines = (element.text || '').split('\n');
    const lineHeight = (element.fontSize || 16) * 1.5;
    const minHeight = 200;
    const padding = 24;
    const autoCalculatedHeight = Math.max(minHeight, (textLines.length * lineHeight) + padding + 20);
    // Use stored height if available, otherwise use auto-calculated
    return {
      x: element.x || 0,
      y: element.y || 0,
      width: element.width || 0,
      height: element.height || autoCalculatedHeight,
    };
  }
  if (element.type === 'circle') {
    // For circles/ellipses, calculate bounding box from center and radii
    const { rx, ry } = getEllipseRadii(element);
    return { x: element.x - rx, y: element.y - ry, width: rx * 2, height: ry * 2 };
  }
  return {
    x: element.x || 0,
    y: element.y || 0,
    width: element.width || 0,
    height: element.height || 0,
  };
}

function isPointNear(point: Point, target: Point, tolerance: number): boolean {
  return point.x >= target.x - tolerance &&
         point.x <= target.x + tolerance &&
         point.y >= target.y - tolerance &&
         point.y <= target.y + tolerance;
}

/** Which corner resize handle (if any) of the element is under `point`. */
export function findResizeHandle(
  element: WhiteboardElement,
  point: Point,
  zoom: number
): { handle: ResizeHandle; box: BoundingBox } | null {
  if (element.type !== 'sticky' && element.type !== 'rectangle' && element.type !== 'circle') {
    return null;
  }
  const handleSize = 8 / zoom;
  const box = getResizeBox(element);

  // Check each corner handle
  const handles: [ResizeHandle, Point][] = [
    ['nw', { x: box.x, y: box.y }],
    ['ne', { x: box.x + box.width, y: box.y }],
    ['sw', { x: box.x, y: box.y + box.height }],
    ['se', { x: box.x + box.width, y: box.y + box.height }],
  ];
  const hit = handles.find(([, handlePos]) => isPointNear(point, handlePos, handleSize));
  return hit ? { handle: hit[0], box } : null;
}

/** Which arrow handle (start, end or curve control) is under `point`. */
export function findArrowHandle(
  element: WhiteboardElement,
  point: Point,
  zoom: number
): { handle: ArrowHandle; position: Point } | null {
  const curvePoints = getArrowCurvePoints(element);
  if (!curvePoints) return null;
  const handleSize = 10 / zoom;

  const candidates: [ArrowHandle, Point][] = [
    ['start', { x: curvePoints.startX, y: curvePoints.startY }],
    ['end', { x: curvePoints.endX, y: curvePoints.endY }],
    ['curve', { x: curvePoints.curveMidX, y: curvePoints.curveMidY }],
  ];
  const hit = candidates.find(([, position]) =>
    Math.abs(point.x - position.x) <= handleSize && Math.abs(point.y - position.y) <= handleSize
  );
  return hit ? { handle: hit[0], position: hit[1] } : null;
}

// ---------------------------------------------------------------------------
// Arrow curve geometry
// ---------------------------------------------------------------------------

function controlPointFor(
  connectionPoint: ConnectionPointName | undefined,
  anchor: Point,
  curveOffset: number
): Point {
  switch (connectionPoint) {
    case 'top':
      return { x: anchor.x, y: anchor.y - curveOffset };
    case 'bottom':
      return { x: anchor.x, y: anchor.y + curveOffset };
    case 'left':
      return { x: anchor.x - curveOffset, y: anchor.y };
    case 'right':
      return { x: anchor.x + curveOffset, y: anchor.y };
    default:
      return { x: anchor.x, y: anchor.y };
  }
}

/** Calculate curve control points for an arrow element. */
export function getArrowCurvePoints(element: WhiteboardElement) {
  if (!element.endX || !element.endY) return null;

  const startX = element.x;
  const startY = element.y;
  const endX = element.endX;
  const endY = element.endY;

  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.hypot(dx, dy);
  const curveOffset = Math.min(distance * 0.5, 150);

  let cp1x: number, cp1y: number, cp2x: number, cp2y: number;

  // Check if there's a custom curve control point
  if (element.curveControlX !== undefined && element.curveControlY !== undefined) {
    // Use quadratic-like control with single control point
    cp1x = element.curveControlX;
    cp1y = element.curveControlY;
    cp2x = element.curveControlX;
    cp2y = element.curveControlY;
  } else if (element.startConnectionPoint && element.endConnectionPoint) {
    // Connected arrows: curve flows naturally from connection points
    const cp1 = controlPointFor(element.startConnectionPoint, { x: startX, y: startY }, curveOffset);
    const cp2 = controlPointFor(element.endConnectionPoint, { x: endX, y: endY }, curveOffset);
    cp1x = cp1.x;
    cp1y = cp1.y;
    cp2x = cp2.x;
    cp2y = cp2.y;
  } else {
    // Non-connected arrows: straight line. Place control points 1/3 and 2/3
    // along the segment so the cubic-bezier renders as a straight line while
    // still giving renderArrowHeadWithTangent a non-zero tangent vector at
    // the end.
    cp1x = startX + dx / 3;
    cp1y = startY + dy / 3;
    cp2x = startX + (2 * dx) / 3;
    cp2y = startY + (2 * dy) / 3;
  }

  // Calculate midpoint of curve for the control handle
  // For a cubic bezier, the point at t=0.5 is: 0.125*P0 + 0.375*P1 + 0.375*P2 + 0.125*P3
  const curveMidX = 0.125 * startX + 0.375 * cp1x + 0.375 * cp2x + 0.125 * endX;
  const curveMidY = 0.125 * startY + 0.375 * cp1y + 0.375 * cp2y + 0.125 * endY;

  return { startX, startY, endX, endY, cp1x, cp1y, cp2x, cp2y, curveMidX, curveMidY };
}

/** Field changes applied to an arrow while one of its handles is dragged. */
export function getArrowHandleUpdate(handle: ArrowHandle, point: Point): Partial<WhiteboardElement> {
  switch (handle) {
    case 'start':
      // Move the start point of the arrow, clearing the start connection
      return {
        x: point.x,
        y: point.y,
        startElementId: undefined,
        startConnectionPoint: undefined,
      };
    case 'end':
      // Move the end point of the arrow, clearing the end connection
      return {
        endX: point.x,
        endY: point.y,
        endElementId: undefined,
        endConnectionPoint: undefined,
      };
    case 'curve':
      // Adjust the curve control point
      return {
        curveControlX: point.x,
        curveControlY: point.y,
      };
  }
}

// ---------------------------------------------------------------------------
// Connections between elements
// ---------------------------------------------------------------------------

/**
 * Connection points (top, right, bottom, left) of a connectable element.
 * `storedTextBox` is the measured bounding box of a text element, when known;
 * without it text falls back to an estimated box.
 */
export function getElementConnectionPoints(
  element: WhiteboardElement,
  storedTextBox?: BoundingBox
): ConnectionPoints | null {
  switch (element.type) {
    case 'rectangle':
    case 'sticky': {
      const centerX = element.x + (element.width || 0) / 2;
      const centerY = element.y + (element.height || 0) / 2;
      return {
        top: { x: centerX, y: element.y },
        right: { x: element.x + (element.width || 0), y: centerY },
        bottom: { x: centerX, y: element.y + (element.height || 0) },
        left: { x: element.x, y: centerY },
      };
    }
    case 'circle': {
      const { rx, ry } = getEllipseRadii(element);
      return {
        top: { x: element.x, y: element.y - ry },
        right: { x: element.x + rx, y: element.y },
        bottom: { x: element.x, y: element.y + ry },
        left: { x: element.x - rx, y: element.y },
      };
    }
    case 'text':
      return storedTextBox ? measuredTextConnectionPoints(storedTextBox) : estimatedTextConnectionPoints(element);
    default:
      return null;
  }
}

/** Use stored bounding box for accurate positioning. */
function measuredTextConnectionPoints(box: BoundingBox): ConnectionPoints {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return {
    top: { x: centerX, y: box.y - 4 },
    right: { x: box.x + box.width + 6, y: centerY },
    bottom: { x: centerX, y: box.y + box.height + 4 },
    left: { x: box.x - 6, y: centerY },
  };
}

/** Fallback to estimation. */
function estimatedTextConnectionPoints(element: WhiteboardElement): ConnectionPoints {
  const textWidth = Math.max(100, estimateTextWidth(element));
  const textHeight = (element.fontSize || 16) * 1.5;
  const centerX = element.x + textWidth / 2;
  return {
    top: { x: centerX, y: element.y - textHeight },
    right: { x: element.x + textWidth, y: element.y - textHeight / 2 },
    bottom: { x: centerX, y: element.y },
    left: { x: element.x, y: element.y - textHeight / 2 },
  };
}

/** Whether the cursor is inside a connectable element's bounds. */
function isCursorInsideConnectable(el: WhiteboardElement, point: Point): boolean {
  switch (el.type) {
    case 'rectangle':
    case 'sticky':
      return point.x >= el.x && point.x <= el.x + (el.width || 0) &&
             point.y >= el.y && point.y <= el.y + (el.height || 0);
    case 'circle': {
      // Ellipse equation
      const { rx, ry } = getEllipseRadii(el);
      const normalizedDist = Math.pow(point.x - el.x, 2) / (rx * rx) + Math.pow(point.y - el.y, 2) / (ry * ry);
      return normalizedDist <= 1;
    }
    case 'text': {
      const textWidth = Math.max(100, estimateTextWidth(el));
      const textHeight = (el.fontSize || 16) * 1.5;
      return point.x >= el.x && point.x <= el.x + textWidth &&
             point.y >= el.y - textHeight && point.y <= el.y;
    }
    default:
      return false;
  }
}

export interface ConnectionHover {
  /** First element the cursor is inside (shows its connection points). */
  elementUnderCursor: string | null;
  /** Nearest connection point within snapping range, if any. */
  nearest: { point: Point; name: ConnectionPointName; elementId: string } | null;
}

/** Nearest connection point within snapping range that beats `bestDistance`. */
function nearestConnectionPoint(
  connectionPoints: ConnectionPoints,
  point: Point,
  bestDistance: number
): { name: ConnectionPointName; position: Point; distance: number } | null {
  const snapDistance = 30; // Distance threshold for snapping
  let best: { name: ConnectionPointName; position: Point; distance: number } | null = null;
  let minDistance = bestDistance;

  // Check distance to each connection point for snapping
  for (const name of CONNECTION_POINT_NAMES) {
    const dist = distanceBetween(point, connectionPoints[name]);
    if (dist < snapDistance && dist < minDistance) {
      minDistance = dist;
      best = { name, position: connectionPoints[name], distance: dist };
    }
  }
  return best;
}

/**
 * While drawing a connection: which element is hovered and which connection
 * point (if any) the end of the arrow should snap to.
 */
export function computeConnectionHover(
  elements: WhiteboardElement[],
  sourceElementId: string,
  point: Point
): ConnectionHover {
  let elementUnderCursor: string | null = null;
  let nearest: ConnectionHover['nearest'] = null;
  let minDistance = Infinity;

  for (const el of elements) {
    if (el.id === sourceElementId || el.type === 'arrow' || el.type === 'path') continue;

    // Track if cursor is inside any element (to show connection points)
    if (!elementUnderCursor && isCursorInsideConnectable(el, point)) {
      elementUnderCursor = el.id;
    }

    const connectionPoints = getElementConnectionPoints(el);
    if (!connectionPoints) continue;

    const candidate = nearestConnectionPoint(connectionPoints, point, minDistance);
    if (candidate) {
      minDistance = candidate.distance;
      nearest = { point: candidate.position, name: candidate.name, elementId: el.id };
    }
  }

  return { elementUnderCursor, nearest };
}

/**
 * Fallback target lookup when a connection is released without a snapped
 * point: the first element (other than the source) with a connection point
 * within the detection radius of `point`.
 */
export function findConnectionTarget(
  elements: WhiteboardElement[],
  sourceElementId: string,
  point: Point,
  getPoints: (element: WhiteboardElement) => ConnectionPoints | null
): { element: WhiteboardElement; pointName: ConnectionPointName } | null {
  const connectionPointRadius = 15; // Detection radius

  for (const el of elements) {
    if (el.id === sourceElementId) continue;
    if (el.type === 'arrow' || el.type === 'path') continue;

    const points = getPoints(el);
    if (!points) continue;

    const pointName = CONNECTION_POINT_NAMES.find(
      name => distanceBetween(point, points[name]) <= connectionPointRadius
    );
    if (pointName) return { element: el, pointName };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dragging and resizing
// ---------------------------------------------------------------------------

/** Element moved by (dx, dy) relative to the geometry captured at drag start. */
export function translateFromStart(el: WhiteboardElement, start: DragStart, dx: number, dy: number): WhiteboardElement {
  const updates: Partial<WhiteboardElement> = { x: start.x + dx, y: start.y + dy };
  // Handle arrow endpoints
  if (el.type === 'arrow' && start.endX !== undefined && start.endY !== undefined) {
    updates.endX = start.endX + dx;
    updates.endY = start.endY + dy;
  }
  // Handle path points
  if (el.type === 'path' && start.points) {
    updates.points = start.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
  }
  return { ...el, ...updates };
}

export interface DragState {
  /** Start geometry of every element in a multi-selection drag. */
  dragElementsStart: Map<string, DragStart>;
  /** Start geometry of the single dragged element. */
  dragElementStart: DragStart;
  selectedElement: string | null;
}

/** Apply a drag delta to the dragged element(s). */
export function applyDragDelta(
  elements: WhiteboardElement[],
  drag: DragState,
  dx: number,
  dy: number
): WhiteboardElement[] {
  // Dragging multiple elements
  if (drag.dragElementsStart.size > 0) {
    return elements.map(el => {
      const startPos = drag.dragElementsStart.get(el.id);
      return startPos ? translateFromStart(el, startPos, dx, dy) : el;
    });
  }
  // Single element dragging
  return elements.map(el =>
    el.id === drag.selectedElement ? translateFromStart(el, drag.dragElementStart, dx, dy) : el
  );
}

/** Copy of `elements` with `patch` merged into the element with the given id. */
export function patchElement(
  elements: WhiteboardElement[],
  id: string | null,
  patch: Partial<WhiteboardElement>
): WhiteboardElement[] {
  return elements.map(el => (el.id === id ? { ...el, ...patch } : el));
}

/** The corner that stays put while `handle` is dragged (its opposite). */
function getFixedCorner(handle: ResizeHandle, start: BoundingBox): Point {
  switch (handle) {
    case 'se': // Dragging bottom-right, fixed point is top-left
      return { x: start.x, y: start.y };
    case 'sw': // Dragging bottom-left, fixed point is top-right
      return { x: start.x + start.width, y: start.y };
    case 'ne': // Dragging top-right, fixed point is bottom-left
      return { x: start.x, y: start.y + start.height };
    case 'nw': // Dragging top-left, fixed point is bottom-right
      return { x: start.x + start.width, y: start.y + start.height };
    default:
      return { x: start.x, y: start.y };
  }
}

/** Ellipse resize: free-form, or a perfect circle while shift is held. */
function computeEllipseResize(point: Point, fixed: Point, shiftKey: boolean): Partial<WhiteboardElement> {
  // Calculate new bounding box from fixed point to mouse position, with minimum size applied
  const newWidth = Math.max(MIN_RESIZE_SIZE, Math.abs(point.x - fixed.x));
  const newHeight = Math.max(MIN_RESIZE_SIZE, Math.abs(point.y - fixed.y));

  // Shift key for proportional (perfect circle)
  const maxDimension = Math.max(newWidth, newHeight);
  const newRx = shiftKey ? maxDimension / 2 : newWidth / 2;
  const newRy = shiftKey ? maxDimension / 2 : newHeight / 2;

  // Position center based on direction from fixed point
  const mouseRight = point.x >= fixed.x;
  const mouseDown = point.y >= fixed.y;

  return {
    radiusX: newRx,
    radiusY: newRy,
    x: mouseRight ? fixed.x + newRx : fixed.x - newRx,
    y: mouseDown ? fixed.y + newRy : fixed.y - newRy,
  };
}

/**
 * Rectangle/sticky resize. Allows flipping when dragging past the fixed
 * corner. `clampBeforeShift` selects whether the minimum size is applied
 * before (document-level drag) or after (canvas drag) the shift-square rule.
 */
function computeRectResize(
  point: Point,
  fixed: Point,
  shiftKey: boolean,
  clampBeforeShift: boolean
): Partial<WhiteboardElement> {
  let newX = Math.min(fixed.x, point.x);
  let newY = Math.min(fixed.y, point.y);
  let newWidth = Math.abs(point.x - fixed.x);
  let newHeight = Math.abs(point.y - fixed.y);

  if (clampBeforeShift) {
    newWidth = Math.max(MIN_RESIZE_SIZE, newWidth);
    newHeight = Math.max(MIN_RESIZE_SIZE, newHeight);
  }

  // Shift key: equal proportions, positioned by the quadrant of the mouse
  if (shiftKey) {
    const maxDimension = Math.max(newWidth, newHeight);
    if (point.x < fixed.x) newX = fixed.x - maxDimension;
    if (point.y < fixed.y) newY = fixed.y - maxDimension;
    newWidth = maxDimension;
    newHeight = maxDimension;
  }

  if (!clampBeforeShift) {
    newWidth = Math.max(MIN_RESIZE_SIZE, newWidth);
    newHeight = Math.max(MIN_RESIZE_SIZE, newHeight);
  }

  return { width: newWidth, height: newHeight, x: newX, y: newY };
}

/** Field changes for resizing `element` by dragging `handle` to `point`. */
export function computeResizeUpdate(
  element: WhiteboardElement,
  handle: ResizeHandle,
  startSize: BoundingBox,
  point: Point,
  shiftKey: boolean,
  clampRectBeforeShift: boolean
): Partial<WhiteboardElement> | null {
  const fixed = getFixedCorner(handle, startSize);
  if (element.type === 'circle') {
    return computeEllipseResize(point, fixed, shiftKey);
  }
  if (element.type === 'rectangle' || element.type === 'sticky') {
    return computeRectResize(point, fixed, shiftKey, clampRectBeforeShift);
  }
  return null;
}

/** New border radius while a rectangle's corner handle is dragged. */
export function computeCornerRadius(
  element: WhiteboardElement,
  handle: CornerHandle,
  point: Point,
  dragStart: CornerRadiusDragStart
): number {
  // Distance from corner towards center
  const maxRadius = Math.min(element.width || 0, element.height || 0) / 2;

  // Distance moved from start position (diagonal towards center)
  const deltaX = point.x - dragStart.x;
  const deltaY = point.y - dragStart.y;

  // Calculate based on which corner is being dragged
  let radiusDelta = 0;
  switch (handle) {
    case 'tl': // Top-left: drag towards bottom-right increases radius
      radiusDelta = (deltaX + deltaY) / 2;
      break;
    case 'tr': // Top-right: drag towards bottom-left increases radius
      radiusDelta = (-deltaX + deltaY) / 2;
      break;
    case 'bl': // Bottom-left: drag towards top-right increases radius
      radiusDelta = (deltaX - deltaY) / 2;
      break;
    case 'br': // Bottom-right: drag towards top-left increases radius
      radiusDelta = (-deltaX - deltaY) / 2;
      break;
  }

  return Math.max(0, Math.min(maxRadius, dragStart.initialRadius + radiusDelta));
}

// ---------------------------------------------------------------------------
// Eraser
// ---------------------------------------------------------------------------

export interface EraserUpdate {
  point: Point;
  size: number;
}

/** Cheap bounds test: true when the eraser is certainly nowhere near. */
function eraserQuickReject(element: WhiteboardElement, eraserPoint: Point, size: number): boolean {
  switch (element.type) {
    case 'rectangle':
    case 'sticky':
      return eraserPoint.x < element.x! - size - 10 ||
             eraserPoint.x > element.x! + element.width! + size + 10 ||
             eraserPoint.y < element.y! - size - 10 ||
             eraserPoint.y > element.y! + element.height! + size + 10;
    case 'circle': {
      const { rx, ry } = getEllipseRadii(element);
      const maxRadius = Math.max(rx, ry);
      const circleDist = distanceBetween(eraserPoint, element);
      return circleDist > maxRadius + size + 10;
    }
    default:
      return false;
  }
}

function eraserHitsPath(element: WhiteboardElement, eraserPoint: Point, size: number): boolean {
  const points = element.points;
  if (!points || points.length <= 1) return false;
  for (let i = 0; i < points.length - 1; i++) {
    if (pointToLineDistance(eraserPoint, points[i], points[i + 1]) <= size) return true;
  }
  return false;
}

function eraserHitsText(element: WhiteboardElement, eraserPoint: Point, size: number): boolean {
  const textWidth = estimateTextWidth(element);
  const textHeight = element.fontSize || 16;
  const textClosestX = Math.max(element.x, Math.min(eraserPoint.x, element.x + textWidth));
  const textClosestY = Math.max(element.y - textHeight, Math.min(eraserPoint.y, element.y));
  return distanceBetween(eraserPoint, { x: textClosestX, y: textClosestY }) <= size;
}

/** Precise intersection test between the eraser and one element. */
function eraserIntersects(element: WhiteboardElement, eraserPoint: Point, size: number): boolean {
  switch (element.type) {
    case 'path':
      return eraserHitsPath(element, eraserPoint, size);
    case 'rectangle':
    case 'sticky': {
      const closestX = Math.max(element.x!, Math.min(eraserPoint.x, element.x! + element.width!));
      const closestY = Math.max(element.y!, Math.min(eraserPoint.y, element.y! + element.height!));
      return distanceBetween(eraserPoint, { x: closestX, y: closestY }) <= size;
    }
    case 'circle': {
      // For ellipse intersection, check if eraser point is close to ellipse boundary
      const { rx, ry } = getEllipseRadii(element);
      // Normalize the point to unit circle space and check distance
      const normalizedX = (eraserPoint.x - element.x) / (rx + size);
      const normalizedY = (eraserPoint.y - element.y) / (ry + size);
      return (normalizedX * normalizedX + normalizedY * normalizedY) <= 1;
    }
    case 'arrow':
      if (element.endX === undefined || element.endY === undefined) return false;
      return pointToLineDistance(
        eraserPoint,
        { x: element.x, y: element.y },
        { x: element.endX, y: element.endY }
      ) <= size;
    case 'text':
      return eraserHitsText(element, eraserPoint, size);
    default:
      return false;
  }
}

/** Ids of the elements touched by any of the queued eraser updates. */
export function findErasedElementIds(elements: WhiteboardElement[], updates: EraserUpdate[]): Set<string> {
  const erased = new Set<string>();
  for (const element of elements) {
    const touched = updates.some(({ point, size }) =>
      !eraserQuickReject(element, point, size) && eraserIntersects(element, point, size)
    );
    if (touched) erased.add(element.id);
  }
  return erased;
}

/** Points to erase at when moving from `last` to `point` (empty for tiny moves). */
export function interpolateEraserPoints(last: Point, point: Point, eraserSize: number): Point[] {
  const dist = distanceBetween(point, last);
  if (dist <= 1) return []; // Process almost every movement for accuracy

  // Interpolate to ensure smooth continuous erasing. Step size should be
  // smaller than eraser radius to ensure full coverage.
  const stepSize = Math.max(3, eraserSize / 4); // Larger erasers need proportional steps
  const steps = Math.min(20, Math.max(1, Math.ceil(dist / stepSize))); // Cap at 20 to prevent lag

  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: last.x + (point.x - last.x) * t,
      y: last.y + (point.y - last.y) * t,
    });
  }
  return points;
}

/** Keep the eraser path reasonably sized. */
export function trimEraserPath(path: Point[]): Point[] {
  return path.length > 100 ? path.slice(-50) : path; // Keep last 50 points
}

// ---------------------------------------------------------------------------
// Shape creation (mouse up)
// ---------------------------------------------------------------------------

/** Rectangle spanned by a drag; a square (anchored at `start`) when shift is held. */
export function computeRectangleBounds(point: Point, start: Point, shiftKey: boolean): BoundingBox {
  let width = Math.abs(point.x - start.x);
  let height = Math.abs(point.y - start.y);
  let x = Math.min(point.x, start.x);
  let y = Math.min(point.y, start.y);

  // If shift was held, make it a square
  if (shiftKey) {
    const size = Math.max(width, height);
    width = size;
    height = size;

    // Adjust position based on drag direction
    if (point.x < start.x) x = start.x - size;
    if (point.y < start.y) y = start.y - size;
  }

  return { x, y, width, height };
}

/** Ellipse spanned by a drag; a perfect circle (anchored at `start`) when shift is held. */
export function computeEllipseBounds(
  point: Point,
  start: Point,
  shiftKey: boolean
): { centerX: number; centerY: number; radiusX: number; radiusY: number } {
  let width = Math.abs(point.x - start.x);
  let height = Math.abs(point.y - start.y);

  // If shift was held, make it a perfect circle
  if (shiftKey) {
    const size = Math.max(width, height);
    width = size;
    height = size;
  }

  const radiusX = width / 2;
  const radiusY = height / 2;

  // Calculate center based on drag direction
  if (shiftKey) {
    return {
      centerX: point.x < start.x ? start.x - width / 2 : start.x + width / 2,
      centerY: point.y < start.y ? start.y - height / 2 : start.y + height / 2,
      radiusX,
      radiusY,
    };
  }
  return {
    centerX: Math.min(point.x, start.x) + radiusX,
    centerY: Math.min(point.y, start.y) + radiusY,
    radiusX,
    radiusY,
  };
}

/** Snapshot of an element's geometry, taken when a drag begins. */
export function snapshotDragStart(el: WhiteboardElement): DragStart {
  return {
    x: el.x || 0,
    y: el.y || 0,
    endX: el.endX,
    endY: el.endY,
    points: el.points ? [...el.points] : undefined,
  };
}

// ---------------------------------------------------------------------------
// Toolbar <-> selected element sync
// ---------------------------------------------------------------------------

export type FillMode = 'fill' | 'stroke' | 'both';

export function isFillableShape(element: WhiteboardElement): boolean {
  return element.type === 'rectangle' || element.type === 'circle';
}

/** Colour changes that make a shape match the chosen fill mode. */
export function getFillModeUpdates(
  element: WhiteboardElement,
  fillMode: FillMode,
  selectedColor: string,
  strokeColor: string
): Partial<WhiteboardElement> {
  const keepFill = element.color === 'transparent' ? selectedColor : element.color;
  const keepStroke = element.strokeColor === 'transparent' ? strokeColor : element.strokeColor;
  return {
    color: fillMode === 'stroke' ? 'transparent' : keepFill,
    strokeColor: fillMode === 'fill' ? 'transparent' : keepStroke,
  };
}

/** The fill mode a shape is currently drawn with. */
export function deriveFillMode(element: WhiteboardElement): FillMode {
  const hasTransparentFill = element.color === 'transparent';
  const hasTransparentStroke = element.strokeColor === 'transparent';
  if (hasTransparentFill && !hasTransparentStroke) return 'stroke';
  if (!hasTransparentFill && hasTransparentStroke) return 'fill';
  return 'both';
}

export interface ToolbarSync {
  strokeWidth?: number;
  fontSize?: number;
  fillMode?: FillMode;
}

/** Toolbar values that should follow the selected element. */
export function getToolbarSync(element: WhiteboardElement): ToolbarSync {
  const sync: ToolbarSync = {};
  if (element.strokeWidth) sync.strokeWidth = element.strokeWidth;
  if (element.fontSize) sync.fontSize = element.fontSize;
  if (isFillableShape(element)) sync.fillMode = deriveFillMode(element);
  return sync;
}

// ---------------------------------------------------------------------------
// Touch gestures
// ---------------------------------------------------------------------------

/** Minimal shape of a touch point (satisfied by both `React.Touch` and DOM `Touch`). */
export interface TouchPoint {
  clientX: number;
  clientY: number;
}

/** Distance between two touches, in screen pixels. */
export function touchDistance(a: TouchPoint, b: TouchPoint): number {
  return Math.sqrt(Math.pow(b.clientX - a.clientX, 2) + Math.pow(b.clientY - a.clientY, 2));
}

/** Screen-space midpoint of two touches. */
export function touchMidpoint(a: TouchPoint, b: TouchPoint): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/** Toolbar styling applied to shapes created by a touch gesture. */
export interface ShapeStyle {
  fillMode: FillMode;
  selectedColor: string;
  strokeColor: string;
  strokeWidth: number;
  arrowType: ArrowType;
}

// A drag shorter than this (in canvas units) is treated as an accidental tap.
const MIN_TOUCH_SHAPE_SIZE = 5;

function getShapeColors(style: ShapeStyle): { color: string; strokeColor: string } {
  return {
    color: style.fillMode === 'stroke' ? 'transparent' : style.selectedColor,
    strokeColor: style.fillMode === 'fill' ? 'transparent' : style.strokeColor,
  };
}

function createTouchRectangle(start: Point, end: Point, style: ShapeStyle): WhiteboardElement | null {
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (!(width > MIN_TOUCH_SHAPE_SIZE || height > MIN_TOUCH_SHAPE_SIZE)) return null;
  return {
    id: Date.now().toString(),
    type: 'rectangle',
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width,
    height,
    ...getShapeColors(style),
    strokeWidth: style.strokeWidth,
  };
}

function createTouchCircle(start: Point, end: Point, style: ShapeStyle): WhiteboardElement | null {
  const radiusX = Math.abs(end.x - start.x) / 2;
  const radiusY = Math.abs(end.y - start.y) / 2;
  if (!(radiusX > MIN_TOUCH_SHAPE_SIZE || radiusY > MIN_TOUCH_SHAPE_SIZE)) return null;
  return {
    id: Date.now().toString(),
    type: 'circle',
    x: Math.min(start.x, end.x) + radiusX,
    y: Math.min(start.y, end.y) + radiusY,
    radiusX,
    radiusY,
    ...getShapeColors(style),
    strokeWidth: style.strokeWidth,
  };
}

function createTouchArrow(start: Point, end: Point, style: ShapeStyle): WhiteboardElement | null {
  const length = distanceBetween(start, end);
  if (Number.isNaN(length) || length <= MIN_TOUCH_SHAPE_SIZE) return null;
  return {
    id: Date.now().toString(),
    type: 'arrow',
    x: start.x,
    y: start.y,
    endX: end.x,
    endY: end.y,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    arrowType: style.arrowType,
  };
}

function createTouchPath(path: Point[], style: ShapeStyle): WhiteboardElement | null {
  if (path.length <= 1) return null;
  return {
    id: Date.now().toString(),
    type: 'path',
    x: 0,
    y: 0,
    points: path,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
  };
}

/**
 * The element a finished touch gesture should create for the active tool, or
 * null when the gesture is too small (or the tool draws nothing on touch end).
 */
export function createElementFromTouch(
  tool: string,
  start: Point,
  end: Point,
  path: Point[],
  style: ShapeStyle
): WhiteboardElement | null {
  switch (tool) {
    case 'rectangle':
      return createTouchRectangle(start, end, style);
    case 'circle':
      return createTouchCircle(start, end, style);
    case 'arrow':
      return createTouchArrow(start, end, style);
    case 'pen':
      return createTouchPath(path, style);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Copies and path simplification
// ---------------------------------------------------------------------------

/** Copy of `el` under a new id, shifted by `offset` so it doesn't sit on the original. */
export function createOffsetCopy(el: WhiteboardElement, id: string, offset = 20): WhiteboardElement {
  return {
    ...el,
    id,
    x: el.x + offset,
    y: el.y + offset,
    ...(el.type === 'arrow' && el.endX && el.endY ? {
      endX: el.endX + offset,
      endY: el.endY + offset,
    } : {}),
    ...(el.type === 'path' && el.points ? {
      points: el.points.map(p => ({ x: p.x + offset, y: p.y + offset })),
    } : {}),
  };
}

/** Simplify path by removing redundant points. */
export function simplifyPath(points: Point[]): Point[] {
  if (points.length <= 2) return points;

  const simplified: Point[] = [points[0]];
  let prevPoint = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    const nextPoint = points[i + 1];

    // Calculate angle between segments
    const angle1 = Math.atan2(point.y - prevPoint.y, point.x - prevPoint.x);
    const angle2 = Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x);
    const angleDiff = Math.abs(angle1 - angle2);

    // Keep point if angle changes significantly or distance is large
    const dist = distanceBetween(point, prevPoint);

    if (angleDiff > 0.1 || dist > 10) {
      simplified.push(point);
      prevPoint = point;
    }
  }

  simplified.push(points.at(-1)!);
  return simplified;
}

// Erased-stroke point count above which an element's strokes are merged.
const MAX_ERASED_POINTS = 500;

/**
 * Merge an element's eraser strokes into one simplified stroke once they hold
 * too many points; returns the element untouched otherwise.
 */
export function consolidateErasedPaths(element: WhiteboardElement): WhiteboardElement {
  const strokes = element.erasedPaths;
  if (!strokes || strokes.length === 0) return element;

  const totalPoints = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  if (totalPoints <= MAX_ERASED_POINTS) return element;

  // Too many points, merge and simplify aggressively
  const allPoints = strokes.flatMap(s => s.points);
  const avgSize = strokes.reduce((sum, s) => sum + s.size, 0) / strokes.length;
  return { ...element, erasedPaths: [{ points: simplifyPath(allPoints), size: avgSize }] };
}
