/**
 * A heatmap drawn on its page: the masked snapshot is rebuilt with rrweb's
 * `Replayer` (in its sandboxed iframe, stopped on the full snapshot) at the
 * width of the device class, grown to the page's full height, and the heat
 * layer is placed over it: click points as a colour-mapped canvas, areas as
 * boxes, scroll depth as bands. Positions are looked up by the collector's
 * element selectors in the rebuilt page.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Replayer } from 'rrweb';
import 'rrweb/dist/style.css';
import type { PanelDeviceClass, PanelHeatmapResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { useI18n } from '@/lib/i18n/provider';
import { DEVICE_VIEWPORT, heatColor, resolveBoxes, resolvePoints, scrollBands, type HeatBox, type HeatPoint } from '../lib/heatmap';
import type { ReplayEvent } from '../lib/replay';
import { fitScale } from '../lib/replay';

const POINT_RADIUS = 30;
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
  const { t, language } = useI18n();
  const th = t.weldpanel.observe.heatmaps;
  const boxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewport = DEVICE_VIEWPORT[deviceClass];
  const [doc, setDoc] = useState<Document | null>(null);
  const [version, setVersion] = useState(0);
  const [docHeight, setDocHeight] = useState(viewport.height);
  const [boxWidth, setBoxWidth] = useState(0);
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
  /* eslint-enable react-hooks/exhaustive-deps */
  const unresolved = resolvedPoints?.unresolved ?? resolvedBoxes?.unresolved ?? 0;

  useEffect(() => {
    onUnresolved?.(unresolved);
    // The count is recomputed on every measure; the callback is only a sink.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unresolved, version]);

  const scale = fitScale(boxWidth, Number.POSITIVE_INFINITY, viewport.width, viewport.height);
  const maxShare = resolvedBoxes ? resolvedBoxes.boxes.reduce((m, b) => Math.max(m, b.share), 0) || 1 : 1;
  const bands = heatmap && type === 'scroll' ? scrollBands(heatmap.scroll.buckets) : [];

  return (
    <div ref={boxRef} className="w-full overflow-hidden rounded-lg border bg-muted/40" data-testid="heatmap-snapshot">
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
        </div>
      </div>
    </div>
  );
}
