/**
 * A world map with a dot per country, as on a realtime analytics overview:
 * every country in a flat grey (a light share of the text colour, with
 * borders in the card colour, so it reads on a card in light and dark), the
 * ones in `items` tinted in the chart colour with a dot whose size follows
 * their value. Under the pointer a country (or its dot) shows a card with its
 * name and value.
 *
 * The shapes are Natural Earth's: the 1:50m set at the whole-world view, and
 * its most detailed 1:10m set, loaded on its own, once someone zooms in.
 *
 * With `zoom` the map moves like an online map: drag to pan, pinch or
 * ⌘/Ctrl + scroll to zoom at the pointer, double-click to zoom in, and the
 * canvas's zoom buttons (`ZoomControls`) bottom right to zoom in, out and
 * back to the whole world. A plain
 * scroll still scrolls the page. Dots and borders keep their size on screen
 * at any zoom.
 *
 * `focus` flies the map to a country: a short eased move and zoom to fit it
 * (straight there for people who ask for less motion), such as when a row of
 * a country list beside the map is clicked, and the country lights up in the
 * full colour for a moment, then fades back. Any drag, zoom or reset stops
 * the flight.
 *
 * The map keeps its shape inside whatever box it gets (`align` says where it
 * sits when the box is wider or taller than the map). Screen readers get the
 * countries as a table. The component holds no text of its own: names and
 * formatted values come in with the items, the column and button names as
 * props.
 */

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { ChartHoverCard } from '@weldsuite/ui/components/chart-hover-card';
import { ChartTooltipRow } from '@weldsuite/ui/components/chart-tooltip-row';
import { ZoomControls, type ZoomControlsLabels } from '@weldsuite/ui/components/zoom-controls';
import { useElementSize } from '@weldsuite/ui/hooks/use-element-size';
import { cardBeside, pointerIn, tint } from '@weldsuite/ui/lib/chart-palette';
import { cn } from '@weldsuite/ui/lib/utils';
import {
  WORLD_COUNTRY_CENTERS,
  WORLD_COUNTRY_PATHS,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
  WORLD_UNNAMED_LAND,
} from '@weldsuite/ui/lib/world-map-data';

export interface WorldMapItem {
  /** ISO 3166-1 alpha-2, such as `NL`; any case. */
  code: string;
  /** The country's name, as shown. */
  label: string;
  /** Sizes the dot. */
  value: number;
  /** The value as shown, such as "12". */
  display: string;
}

/** The zoom buttons' names; `reset` goes back to the whole world. */
export type WorldMapZoomLabels = ZoomControlsLabels;

export interface WorldMapProps {
  items: WorldMapItem[];
  /** What the value is ("Active visitors"): the hover card's row and the table's column. */
  valueLabel: string;
  /** The table's first column ("Country"). */
  countryLabel: string;
  /** Names the map for assistive tech. */
  label?: string;
  /** Tints and dots; `--chart-1` by default. */
  color?: string;
  /** Where the map sits in a box of another shape. */
  align?: 'left' | 'center' | 'right';
  /** Lets people pan and zoom; the zoom buttons' names. Without it the map stays still. */
  zoom?: WorldMapZoomLabels;
  /** Flies the map to this country (ISO code) each time a new object comes in, so a second click on the same country flies back to it. */
  focus?: { code: string } | null;
  className?: string;
}

/** Where the map is: zoomed `k` times, moved by `x`, `y` map units. */
export interface WorldMapView {
  k: number;
  x: number;
  y: number;
}

const ALIGN = { left: 'xMinYMid', center: 'xMidYMid', right: 'xMaxYMid' } as const;
/** Dot radius in screen pixels: the smallest value's and the biggest's. */
const DOT_MIN = 4;
const DOT_MAX = 12;
const HOME: WorldMapView = { k: 1, x: 0, y: 0 };
/** Deep enough to show a small country such as the Netherlands or Belgium large. */
const MAX_ZOOM = 24;
/** From this zoom on, the map draws Natural Earth's most detailed (1:10m) shapes. */
const DETAIL_ZOOM = 2;

interface Shapes {
  paths: Readonly<Record<string, string>>;
  unnamed: string;
}

const WORLD_SHAPES: Shapes = { paths: WORLD_COUNTRY_PATHS, unnamed: WORLD_UNNAMED_LAND };
/** A press that moves less than this many pixels is a click, not a drag. */
const DRAG_SLOP = 3;
/** How long flying to a country takes, in ms. */
const FLY_MS = 700;
/** How long a zoom button or a double-click takes to zoom, and the reset to go back to the whole world. */
const ZOOM_MS = 300;
const RESET_MS = 500;
/** How much of the view a focused country's main parts fill, and the zooms it may get (a tiny one is not blown up past the max). */
const FOCUS_FILL = 0.75;
const FOCUS_MIN_ZOOM = 1;
const FOCUS_MAX_ZOOM = MAX_ZOOM;
/** A country's parts this big next to its largest one count as main parts (Alaska does, the Caribbean Netherlands do not). */
const MAIN_PART_SHARE = 0.1;
/** How long a focused country stays lit after the flight. */
const FLASH_MS = 500;

interface Hover {
  code: string;
  left: number;
  top: number;
}

interface Drag {
  pointerId: number;
  clientX: number;
  clientY: number;
  from: WorldMapView;
  moved: boolean;
}

/** Each item's dot radius in screen pixels: the area follows the value. */
export function dotRadius(value: number, max: number): number {
  if (max <= 0 || value <= 0) return DOT_MIN;
  return DOT_MIN + (DOT_MAX - DOT_MIN) * Math.sqrt(value / max);
}

/** A view kept between the whole world and `MAX_ZOOM`, never showing past the map's edges. */
export function clampView(view: WorldMapView): WorldMapView {
  const k = Math.min(MAX_ZOOM, Math.max(1, view.k));
  return {
    k,
    x: Math.min(0, Math.max(WORLD_MAP_WIDTH * (1 - k), view.x)),
    y: Math.min(0, Math.max(WORLD_MAP_HEIGHT * (1 - k), view.y)),
  };
}

/** Zooms by `factor` keeping the map point under (`px`, `py`) (in the map's own units) where it is. */
export function zoomAt(view: WorldMapView, factor: number, px: number, py: number): WorldMapView {
  const k = Math.min(MAX_ZOOM, Math.max(1, view.k * factor));
  const ratio = k / view.k;
  return clampView({ k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio });
}

/** The map point in the middle of the view. */
function centerOf(view: WorldMapView) {
  return { x: (WORLD_MAP_WIDTH / 2 - view.x) / view.k, y: (WORLD_MAP_HEIGHT / 2 - view.y) / view.k };
}

/** The view with the map point (`cx`, `cy`) in the middle, zoomed `k` times (kept inside the map). */
export function viewCentredOn(cx: number, cy: number, k: number): WorldMapView {
  return clampView({ k, x: WORLD_MAP_WIDTH / 2 - cx * k, y: WORLD_MAP_HEIGHT / 2 - cy * k });
}

/** Part of the way (`t`, 0 to 1) from one view to another: the middle moves in a straight line, the zoom evenly in scale. */
export function viewBetween(from: WorldMapView, to: WorldMapView, t: number): WorldMapView {
  const a = centerOf(from);
  const b = centerOf(to);
  const k = from.k * Math.pow(to.k / from.k, t);
  return viewCentredOn(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, k);
}

/** A part's box in map units: left, top, right, bottom. */
type PartBox = [number, number, number, number];

/** Where a path is drawing: the current point and where its part started (for `Z`). */
interface Pen {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

/** The straight-line commands: how many numbers each takes and where they move the pen. */
const LINE_STEPS: Readonly<Record<string, { size: number; move: (pen: Pen, n: readonly number[]) => void }>> = {
  L: { size: 2, move: (pen, n) => Object.assign(pen, { x: n[0] ?? pen.x, y: n[1] ?? pen.y }) },
  l: { size: 2, move: (pen, n) => Object.assign(pen, { x: pen.x + (n[0] ?? 0), y: pen.y + (n[1] ?? 0) }) },
  H: { size: 1, move: (pen, n) => Object.assign(pen, { x: n[0] ?? pen.x }) },
  h: { size: 1, move: (pen, n) => Object.assign(pen, { x: pen.x + (n[0] ?? 0) }) },
  V: { size: 1, move: (pen, n) => Object.assign(pen, { y: n[0] ?? pen.y }) },
  v: { size: 1, move: (pen, n) => Object.assign(pen, { y: pen.y + (n[0] ?? 0) }) },
};

/** Draws lines from the pen with `numbers`, growing the part's box. */
function lineTo(pen: Pen, box: PartBox | undefined, command: string, numbers: readonly number[]) {
  const step = LINE_STEPS[command];
  if (!step || !box) return;
  for (let i = 0; i + step.size <= numbers.length; i += step.size) {
    step.move(pen, numbers.slice(i, i + step.size));
    box[0] = Math.min(box[0], pen.x);
    box[1] = Math.min(box[1], pen.y);
    box[2] = Math.max(box[2], pen.x);
    box[3] = Math.max(box[3], pen.y);
  }
}

/** Starts a part; the pairs after the first are lines, as SVG reads them. */
function moveTo(pen: Pen, boxes: PartBox[], relative: boolean, numbers: readonly number[]) {
  const fromPen = relative && boxes.length > 0;
  pen.x = (fromPen ? pen.x : 0) + (numbers[0] ?? 0);
  pen.y = (fromPen ? pen.y : 0) + (numbers[1] ?? 0);
  pen.startX = pen.x;
  pen.startY = pen.y;
  const box: PartBox = [pen.x, pen.y, pen.x, pen.y];
  boxes.push(box);
  lineTo(pen, box, relative ? 'l' : 'L', numbers.slice(2));
}

/** The box of each part of a path made of straight lines (M, L, H, V, Z, absolute or relative). */
export function partBoxes(d: string): PartBox[] {
  const boxes: PartBox[] = [];
  const pen: Pen = { x: 0, y: 0, startX: 0, startY: 0 };
  for (const segment of d.split(/(?=[a-z])/i)) {
    const command = segment.charAt(0);
    const numbers = (segment.slice(1).match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? []).map(Number);
    if (command === 'M' || command === 'm') moveTo(pen, boxes, command === 'm', numbers);
    else if (command === 'Z' || command === 'z') Object.assign(pen, { x: pen.startX, y: pen.startY });
    else lineTo(pen, boxes.at(-1), command, numbers);
  }
  return boxes;
}

/**
 * The box (in map units) around a country's main parts: its largest part and
 * any other at least `MAIN_PART_SHARE` of its size (Alaska next to the
 * mainland US), leaving out small far-off islands and territories (the
 * Caribbean Netherlands, French Guiana) that would make the box half the
 * world.
 */
export function mainPartsBox(d: string): { x: number; y: number; width: number; height: number } | null {
  const parts = partBoxes(d);
  const area = (p: PartBox) => (p[2] - p[0]) * (p[3] - p[1]);
  const largest = Math.max(0, ...parts.map(area));
  const main = parts.filter((p) => area(p) >= largest * MAIN_PART_SHARE);
  if (main.length === 0) return null;
  const left = Math.min(...main.map((p) => p[0]));
  const top = Math.min(...main.map((p) => p[1]));
  const right = Math.max(...main.map((p) => p[2]));
  const bottom = Math.max(...main.map((p) => p[3]));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Slow in, slow out. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function prefersLessMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A move of the map under way: its next frame, and where it ends (so a second click zooms on from there). */
interface Flight {
  frame: number | null;
  goal: WorldMapView | null;
}

function stopFlight(flight: { current: Flight }) {
  if (flight.current.frame !== null) cancelAnimationFrame(flight.current.frame);
  flight.current = { frame: null, goal: null };
}

/** Glides the view from `from` to `to` in `ms`, eased; straight there for people who ask for less motion. */
function animateView(flight: { current: Flight }, from: WorldMapView, to: WorldMapView, ms: number, setView: (view: WorldMapView) => void) {
  stopFlight(flight);
  if (prefersLessMotion()) {
    setView(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    setView(viewBetween(from, to, easeInOut(t)));
    flight.current = t < 1 ? { frame: requestAnimationFrame(step), goal: to } : { frame: null, goal: null };
  };
  flight.current = { frame: requestAnimationFrame(step), goal: to };
}

/** A point on screen in the map's own units (the SVG's viewBox), or null where the browser can't tell. */
function toMap(svg: SVGSVGElement | null, clientX: number, clientY: number) {
  const matrix = svg?.getScreenCTM();
  if (!matrix) return null;
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

export function WorldMap({
  items,
  valueLabel,
  countryLabel,
  label,
  color = 'var(--chart-1)',
  align = 'center',
  zoom,
  focus,
  className,
}: Readonly<WorldMapProps>) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState<WorldMapView>(HOME);
  const viewRef = useRef(view);
  const flight = useRef<Flight>({ frame: null, goal: null });
  const [flash, setFlash] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [detail, setDetail] = useState<Shapes | null>(null);
  const zoomable = zoom !== undefined;
  const zoomedIn = view.k >= DETAIL_ZOOM;
  const shapes = zoomedIn && detail ? detail : WORLD_SHAPES;
  const byCode = new Map(items.filter((item) => item.value > 0).map((item) => [item.code.toUpperCase(), item]));
  const max = Math.max(0, ...items.map((item) => item.value));
  // Screen pixels per map unit at the whole-world view, so dots keep their pixel size at any width and zoom.
  const scale = size.width > 0 && size.height > 0 ? Math.min(size.width / WORLD_MAP_WIDTH, size.height / WORLD_MAP_HEIGHT) : 1;
  const active = hover ? byCode.get(hover.code) : undefined;
  // Biggest first, so a small neighbour's dot stays on top.
  const dots = [...byCode.entries()]
    .filter(([code]) => WORLD_COUNTRY_CENTERS[code])
    .sort(([, a], [, b]) => b.value - a.value);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // A move under way stops with the map.
  useEffect(() => () => stopFlight(flight), []);

  /** Glides to a view; zooms that follow one under way start from where it ends. */
  const glide = (to: (base: WorldMapView) => WorldMapView, ms: number) => {
    const base = flight.current.goal ?? viewRef.current;
    animateView(flight, viewRef.current, to(base), ms, setView);
  };

  // Fly to the focused country: centred on its dot, zoomed to fit its shape.
  useEffect(() => {
    if (!focus) return;
    const code = focus.code.toUpperCase();
    const center = WORLD_COUNTRY_CENTERS[code];
    if (!center) return;
    const shape = WORLD_COUNTRY_PATHS[code];
    const box = shape ? mainPartsBox(shape) : null;
    const fits = box !== null && box.width > 0 && box.height > 0;
    const fit = fits ? FOCUS_FILL * Math.min(WORLD_MAP_WIDTH / box.width, WORLD_MAP_HEIGHT / box.height) : FOCUS_MAX_ZOOM;
    const [cx, cy] = fits ? [box.x + box.width / 2, box.y + box.height / 2] : center;
    const target = viewCentredOn(cx, cy, Math.min(FOCUS_MAX_ZOOM, Math.max(FOCUS_MIN_ZOOM, fit)));
    setHover(null);
    setFlash(code);
    const unlight = window.setTimeout(() => setFlash(null), (prefersLessMotion() ? 0 : FLY_MS) + FLASH_MS);
    animateView(flight, viewRef.current, target, FLY_MS, setView);
    return () => {
      window.clearTimeout(unlight);
      stopFlight(flight);
    };
  }, [focus]);

  // Pinch and ⌘/Ctrl + scroll zoom at the pointer. A native listener: React's
  // wheel handler is passive, so it could not keep the page from zooming too.
  useEffect(() => {
    const svg = svgRef.current;
    if (!zoomable || !svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      stopFlight(flight);
      const at = toMap(svg, event.clientX, event.clientY);
      if (at) setView((current) => zoomAt(current, Math.exp(-event.deltaY * 0.01), at.x, at.y));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomable]);

  // The 1:10m shapes (about 2 MB) load on the first zoom past `DETAIL_ZOOM`;
  // until they are in, the 1:50m ones stay on screen.
  useEffect(() => {
    if (!zoomedIn || detail) return;
    let current = true;
    void import('@weldsuite/ui/lib/world-map-detail').then((module) => {
      if (current) setDetail({ paths: module.WORLD_COUNTRY_PATHS_DETAIL, unnamed: module.WORLD_UNNAMED_LAND_DETAIL });
    });
    return () => {
      current = false;
    };
  }, [zoomedIn, detail]);

  const point = (code: string) => (event: PointerEvent) => {
    if (drag.current?.moved) return;
    if (!byCode.has(code)) return setHover(null);
    const pointer = pointerIn(ref.current, event);
    if (pointer) setHover({ code, ...cardBeside(pointer) });
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (!zoomable || event.button !== 0) return;
    stopFlight(flight);
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, from: view, moved: false };
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.clientX;
    const dy = event.clientY - current.clientY;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      setHover(null);
    }
    setView(clampView({ k: current.from.k, x: current.from.x + dx / scale, y: current.from.y + dy / scale }));
  };

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onDoubleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!zoomable) return;
    const at = toMap(svgRef.current, event.clientX, event.clientY);
    if (at) glide((base) => zoomAt(base, 2, at.x, at.y), ZOOM_MS);
  };

  /** The buttons zoom at the middle of what is in view. */
  const zoomBy = (factor: number) => glide((base) => zoomAt(base, factor, WORLD_MAP_WIDTH / 2, WORLD_MAP_HEIGHT / 2), ZOOM_MS);

  return (
    <div ref={ref} className={cn('relative', className)} onPointerLeave={() => setHover(null)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WORLD_MAP_WIDTH} ${WORLD_MAP_HEIGHT}`}
        preserveAspectRatio={`${ALIGN[align]} meet`}
        className={cn(
          'size-full',
          // On touch, a vertical swipe over the whole world still scrolls the page; once zoomed in, it moves the map.
          zoomable && (view.k > 1 ? 'touch-none' : 'touch-pan-y'),
          zoomable && (dragging ? 'cursor-grabbing select-none' : 'cursor-grab'),
        )}
        role="img"
        aria-label={label}
        shapeRendering="geometricPrecision"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* Land is a light share of the text colour, so it shows on a card in both themes; borders are the card colour. */}
          <g className="fill-foreground/10 stroke-card dark:fill-foreground/[0.16]" strokeWidth={1} strokeLinejoin="round">
            <path d={shapes.unnamed} vectorEffect="non-scaling-stroke" />
            {Object.entries(shapes.paths).map(([code, d]) => {
              const item = byCode.get(code);
              let fill: string | undefined;
              if (flash === code) fill = color;
              else if (item) fill = tint(color, hover?.code === code ? 55 : 35);
              return (
                <path
                  key={code}
                  data-code={code}
                  d={d}
                  style={fill ? { fill } : undefined}
                  className="transition-[fill] duration-500 motion-reduce:transition-none"
                  vectorEffect="non-scaling-stroke"
                  onPointerMove={point(code)}
                />
              );
            })}
          </g>
          <g className="stroke-card" strokeWidth={1.5}>
            {dots.map(([code, item]) => {
              const [cx, cy] = WORLD_COUNTRY_CENTERS[code]!;
              return (
                <circle
                  key={code}
                  cx={cx}
                  cy={cy}
                  r={dotRadius(item.value, max) / (scale * view.k)}
                  fill={color}
                  fillOpacity={hover?.code === code || flash === code ? 1 : 0.85}
                  vectorEffect="non-scaling-stroke"
                  onPointerMove={point(code)}
                />
              );
            })}
          </g>
        </g>
      </svg>

      {zoom && (
        <ZoomControls
          className="absolute bottom-4 right-4 z-10"
          onZoomIn={() => zoomBy(2)}
          onZoomOut={() => zoomBy(0.5)}
          onReset={() => glide(() => HOME, RESET_MS)}
          labels={zoom}
        />
      )}

      {hover && active && (
        <ChartHoverCard title={active.label} className="pointer-events-none absolute z-10" style={{ left: hover.left, top: hover.top }}>
          <ChartTooltipRow label={valueLabel} value={active.display} color={color} swatch="square" />
        </ChartHoverCard>
      )}

      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">{countryLabel}</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {[...byCode.values()]
            .sort((a, b) => b.value - a.value)
            .map((item) => (
              <tr key={item.code}>
                <th scope="row">{item.label}</th>
                <td>{item.display}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
