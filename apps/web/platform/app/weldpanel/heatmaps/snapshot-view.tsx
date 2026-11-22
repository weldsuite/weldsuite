/**
 * A heatmap drawn on its page: the masked snapshot is rebuilt with rrweb's
 * `Replayer` (in its sandboxed iframe, stopped on the full snapshot) at the
 * width of the device class, grown to the page's full height, and the heat
 * layer is placed over it: click points as a colour-mapped canvas, areas as
 * boxes, scroll depth as bands. Positions are looked up by the collector's
 * element selectors in the rebuilt page.
 *
 * Every clicked element found on the page gets an invisible hit area: under
 * the pointer (or keyboard focus) a card next to it shows its clicks, its
 * share of all clicks and its rank; a click pins the card until another click
 * elsewhere or Escape.
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/style.css';
import type { PanelDeviceClass, PanelHeatmapResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { useI18n } from '@/lib/i18n/provider';
import { DEVICE_VIEWPORT, heatColor, resolveBoxes, resolvePoints, scrollBands, type HeatBox, type HeatPoint } from '../lib/heatmap';
import type { ReplayEvent } from '../lib/replay';
import { fitScale } from '../lib/replay';

const POINT_RADIUS = 30;
/** The details card's widest (`max-w-60`), to keep it inside the snapshot. */
const CARD_WIDTH = 240;
const CARD_GAP = 8;
/** Room around a hit area, so its outline sits around the button rather than on its edge. */
const HIT_OUTSET = 4;
/** Pages finish loading styles and fonts after the first paint; measure again a few times. */
const REMEASURE_MS = [0, 300, 1200, 3000];

/** Paints click points as soft blobs, then maps their density onto the colour ramp. */
export function paintHeat(canvas: HTMLCanvasElement, points: readonly HeatPoint[]): void {
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const point of points) {
    const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, POINT_RADIUS);
    const alpha = Math.min(1, 0.2 + point.intensity * 0.5);
    gradient.addColorStop(0, `rgba(0,0,0,${alpha})`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(point.x - POINT_RADIUS, point.y - POINT_RADIUS, POINT_RADIUS * 2, POINT_RADIUS * 2);
  }
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a === 0) continue;
    const match = /rgba\((\d+), (\d+), (\d+), /.exec(heatColor(a));
    if (!match) continue;
    data[i] = Number(match[1]);
    data[i + 1] = Number(match[2]);
    data[i + 2] = Number(match[3]);
    data[i + 3] = Math.round(Math.min(1, a * 1.4) * 200);
  }
  ctx.putImageData(image, 0, 0);
}

/** Where the details card goes, in the snapshot's own pixels: right of the element, or left of it near the edge. */
export function cardPosition(box: Pick<HeatBox, 'x' | 'y' | 'width'>, scale: number, offsetX: number, boxWidth: number): { left: number; top: number } {
  const right = offsetX + (box.x + box.width) * scale + CARD_GAP;
  const left = right + CARD_WIDTH > boxWidth ? Math.max(offsetX + box.x * scale - CARD_GAP - CARD_WIDTH, 0) : right;
  return { left, top: Math.max(box.y * scale, 0) };
}

function HeatCanvas({ width, height, points }: Readonly<{ width: number; height: number; points: readonly HeatPoint[] }>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintHeat(ref.current, points);
  }, [points, width, height]);
  return <canvas ref={ref} width={width} height={height} className="absolute left-0 top-0" aria-hidden />;
}

interface SnapshotViewProps {
  snapshot: ReplayEvent;
  deviceClass: PanelDeviceClass;
  heatmap: PanelHeatmapResult | undefined;
  /** Reports clicks that could not be placed on the page. */
  onUnresolved?: (count: number) => void;
  onBroken?: () => void;
}

export function SnapshotView({ snapshot, deviceClass, heatmap, onUnresolved, onBroken }: Readonly<SnapshotViewProps>) {
  const { t, language, format } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewport = DEVICE_VIEWPORT[deviceClass];
  const [doc, setDoc] = useState<Document | null>(null);
  const [version, setVersion] = useState(0);
  const [docHeight, setDocHeight] = useState(viewport.height);
  const [boxWidth, setBoxWidth] = useState(0);
  /** The element whose card is open; `pinned` when it was clicked rather than hovered. */
  const [active, setActive] = useState<{ selector: string; pinned: boolean } | null>(null);
  const onBrokenRef = useRef(onBroken);
  onBrokenRef.current = onBroken;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let replayer: Replayer;
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      // The snapshot has no Meta event, so one is made up at the width of the device class.
      const meta = { type: 4, timestamp: snapshot.timestamp, data: { href: '', width: viewport.width, height: viewport.height } };
      const full = { ...snapshot, timestamp: snapshot.timestamp + 1 };
      replayer = new Replayer([meta, full] as unknown as ConstructorParameters<typeof Replayer>[0], {
        root: stage,
        showWarning: false,
        mouseTail: false,
        skipInactive: false,
        triggerFocus: false,
      });
      replayer.pause(replayer.getMetaData().totalTime);
    } catch {
      onBrokenRef.current?.();
      return;
    }
    const measure = () => {
      const document_ = replayer.iframe.contentDocument;
      if (!document_) return;
      const height = Math.max(document_.documentElement?.scrollHeight ?? 0, document_.body?.scrollHeight ?? 0, viewport.height);
      replayer.iframe.style.height = `${height}px`;
      replayer.wrapper.style.height = `${height}px`;
      setDocHeight(height);
      setDoc(document_);
      setVersion((v) => v + 1);
    };
    for (const ms of REMEASURE_MS) timers.push(setTimeout(measure, ms));
    return () => {
      for (const timer of timers) clearTimeout(timer);
      try {
        replayer.destroy();
      } catch {
        // Gone with its container.
      }
      setDoc(null);
    };
  }, [snapshot, viewport.width, viewport.height]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBoxWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const type = heatmap?.type;
  // `version` stands for the page having been measured again.
  /* eslint-disable react-hooks/exhaustive-deps */
  const resolvedPoints = useMemo(() => (doc && heatmap && type === 'click' ? resolvePoints(doc, heatmap.points) : null), [doc, heatmap, type, version]);
  const resolvedBoxes = useMemo(() => (doc && heatmap && type === 'area' ? resolveBoxes(doc, heatmap.elements) : null), [doc, heatmap, type, version]);
  // Clicks are drawn as points, but each clicked element still gets a hit area for its card.
  const hitBoxes = useMemo(
    () => (doc && heatmap && type !== 'scroll' ? (resolvedBoxes?.boxes ?? resolveBoxes(doc, heatmap.elements).boxes) : []),
    [doc, heatmap, type, resolvedBoxes, version],
  );
  /* eslint-enable react-hooks/exhaustive-deps */
  const ranks = useMemo(() => new Map([...(heatmap?.elements ?? [])].sort((a, b) => b.clicks - a.clicks).map((element, index) => [element.selector, index + 1])), [heatmap]);
  const unresolved = resolvedPoints?.unresolved ?? resolvedBoxes?.unresolved ?? 0;

  // A pinned card closes on Escape or on a press anywhere but an element's hit area.
  const pinned = active?.pinned ?? false;
  useEffect(() => {
    if (!pinned) return;
    const close = () => setActive(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-testid="heatmap-hit"]')) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pinned]);

  useEffect(() => {
    onUnresolved?.(unresolved);
    // The count is recomputed on every measure; the callback is only a sink.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unresolved, version]);

  const scale = fitScale(boxWidth, Number.POSITIVE_INFINITY, viewport.width, viewport.height);
  const maxShare = resolvedBoxes ? resolvedBoxes.boxes.reduce((m, b) => Math.max(m, b.share), 0) || 1 : 1;
  const bands = heatmap && type === 'scroll' ? scrollBands(heatmap.scroll.buckets) : [];
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
  const count = new Intl.NumberFormat(language);
  const offsetX = Math.max((boxWidth - viewport.width * scale) / 2, 0);
  const open = active ? hitBoxes.find((box) => box.selector === active.selector) : undefined;

  // Hovering shows a card unless another one is pinned; leaving closes an unpinned one.
  const hover = (selector: string) => setActive((current) => (current?.pinned ? current : { selector, pinned: false }));
  const leave = () => setActive((current) => (current?.pinned ? current : null));
  const pin = (event: MouseEvent, selector: string) => {
    event.stopPropagation();
    setActive((current) => (current?.pinned && current.selector === selector ? null : { selector, pinned: true }));
  };

  return (
    <div ref={boxRef} className="relative w-full overflow-hidden border bg-muted/40" data-testid="heatmap-snapshot">
      <div className="mx-auto overflow-hidden bg-white" style={{ width: viewport.width * scale, height: docHeight * scale }}>
        <div className="relative origin-top-left" style={{ width: viewport.width, height: docHeight, transform: `scale(${scale})` }}>
          <div ref={stageRef} className="absolute left-0 top-0" />
          <div className="pointer-events-none absolute inset-0" aria-hidden={type !== 'area' && type !== 'scroll'}>
            {resolvedPoints && <HeatCanvas width={viewport.width} height={docHeight} points={resolvedPoints.points} />}
            {resolvedBoxes?.boxes.map((box: HeatBox) => (
              <div
                key={box.selector}
                data-testid="heatmap-box"
                title={`${box.text ?? box.selector}: ${box.clicks}`}
                className="absolute rounded-sm border"
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  background: heatColor(box.share / maxShare, 0.45),
                  borderColor: heatColor(box.share / maxShare, 0.9),
                }}
              >
                <span className="absolute left-0 top-0 rounded-br bg-black/70 px-1 text-[11px] font-semibold leading-4 text-white">
                  {new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(box.share)}
                </span>
              </div>
            ))}
            {bands.map((band) => (
              <div
                key={band.fromPercent}
                data-testid="heatmap-band"
                className="absolute inset-x-0"
                style={{
                  top: `${band.fromPercent}%`,
                  height: `${Math.max(0, band.toPercent - band.fromPercent)}%`,
                  background: heatColor(band.reachedShare, 0.42),
                }}
              >
                <span className="absolute right-2 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                  {th.scrollReached
                    .replace('{share}', new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(band.reachedShare))
                    .replace('{depth}', String(band.fromPercent))}
                </span>
              </div>
            ))}
          </div>
          {hitBoxes.map((box) => {
            const name = box.text ?? box.selector;
            return (
              <button
                key={box.selector}
                type="button"
                data-testid="heatmap-hit"
                aria-label={format(th.hover.label, { name, clicks: count.format(box.clicks), share: percent.format(box.share) })}
                aria-pressed={active?.selector === box.selector && active.pinned}
                // The snapshot is the site's own (usually light) page in either theme: a fixed blue ring and tint
                // stay visible on it, where the theme's foreground colour vanishes on white in dark mode.
                className={`absolute rounded-md outline-none transition-[box-shadow,background-color] hover:bg-blue-500/10 hover:ring-2 hover:ring-blue-500 focus-visible:bg-blue-500/10 focus-visible:ring-2 focus-visible:ring-blue-600 ${
                  active?.selector === box.selector ? 'bg-blue-500/15 ring-2 ring-blue-600' : ''
                }`}
                style={{ left: box.x - HIT_OUTSET, top: box.y - HIT_OUTSET, width: box.width + HIT_OUTSET * 2, height: box.height + HIT_OUTSET * 2 }}
                onPointerEnter={() => hover(box.selector)}
                onPointerLeave={leave}
                onFocus={() => hover(box.selector)}
                onBlur={leave}
                onClick={(event) => pin(event, box.selector)}
              />
            );
          })}
        </div>
      </div>
      {open && (
        // The stock shadcn chart tooltip (`ChartTooltipContent` without indicators), as on every chart.
        <div
          aria-hidden
          data-testid="heatmap-card"
          className="border-border/50 bg-background pointer-events-none absolute z-10 grid w-max min-w-[8rem] max-w-60 items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
          style={cardPosition(open, scale, offsetX, boxWidth)}
        >
          <div className="truncate font-medium">{open.text ?? open.selector}</div>
          <div className="grid gap-1.5">
            {[
              { name: th.hover.clicks, value: count.format(open.clicks) },
              { name: th.hover.share, value: percent.format(open.share) },
              { name: th.hover.rank, value: format(th.hover.rankValue, { rank: ranks.get(open.selector) ?? '–', total: ranks.size }) },
            ].map((row) => (
              <div key={row.name} className="flex w-full items-stretch gap-2">
                <div className="flex flex-1 justify-between gap-4 leading-none">
                  <span className="text-muted-foreground">{row.name}</span>
                  <span className="text-foreground font-mono font-medium tabular-nums">{row.value}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
