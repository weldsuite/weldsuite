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
const MAX_ZOOM = 12;
/** From this zoom on, the map draws Natural Earth's most detailed (1:10m) shapes. */
const DETAIL_ZOOM = 2;

interface Shapes {
  paths: Readonly<Record<string, string>>;
  unnamed: string;
}

const WORLD_SHAPES: Shapes = { paths: WORLD_COUNTRY_PATHS, unnamed: WORLD_UNNAMED_LAND };
/** A press that moves less than this many pixels is a click, not a drag. */
const DRAG_SLOP = 3;

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
  className,
}: Readonly<WorldMapProps>) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [view, setView] = useState<WorldMapView>(HOME);
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

  // Pinch and ⌘/Ctrl + scroll zoom at the pointer. A native listener: React's
  // wheel handler is passive, so it could not keep the page from zooming too.
  useEffect(() => {
    const svg = svgRef.current;
    if (!zoomable || !svg) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
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
    if (at) setView((current) => zoomAt(current, 2, at.x, at.y));
  };

  /** The buttons zoom at the middle of what is in view. */
  const zoomBy = (factor: number) => setView((current) => zoomAt(current, factor, WORLD_MAP_WIDTH / 2, WORLD_MAP_HEIGHT / 2));

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
              const fill = item ? tint(color, hover?.code === code ? 55 : 35) : undefined;
              return <path key={code} d={d} style={fill ? { fill } : undefined} vectorEffect="non-scaling-stroke" onPointerMove={point(code)} />;
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
                  fillOpacity={hover?.code === code ? 1 : 0.85}
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
          onReset={() => setView(HOME)}
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
