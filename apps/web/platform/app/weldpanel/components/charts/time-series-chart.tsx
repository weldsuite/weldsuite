/**
 * Line or bar chart over time on the library's `ChartContainer` (recharts).
 * Series come as columns of `data`; a series with `dashed` is drawn dotted
 * (the previous period).
 *
 * Annotations: where the WeldPanel layout turns them on
 * (`ChartAnnotationsProvider`) and the points carry their `bucket`, the
 * project's annotations (and the open report's own) show as vertical lines
 * with a marker; hovering the marker names them, clicking it lists them, and
 * clicking a date on the chart adds one there.
 */

import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis, type MouseHandlerDataParam } from 'recharts';
import type { PanelAnnotationDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { useCan } from '@weldsuite/permissions/react';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@weldsuite/ui/components/chart';
import { cn } from '@weldsuite/ui/lib/utils';
import { useWeldPanelAnnotations } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useSearchParams } from '@/lib/router';
import { annotationTimeForBucket, annotationsByBucket, bucketRange } from '../../lib/annotations';
import { formatCompact, formatNumber } from '../../lib/format';
import { useCurrentProject } from '../../lib/use-current-project';
import { useChartAnnotationsScope, type ChartAnnotationsScope } from './annotations-context';

// Loaded when opened, so a chart costs nothing extra until someone annotates it.
const AnnotationEditDialog = lazy(() => import('../annotation-dialogs').then((m) => ({ default: m.AnnotationEditDialog })));
const AnnotationsListDialog = lazy(() => import('../annotation-dialogs').then((m) => ({ default: m.AnnotationsListDialog })));

export interface ChartSeries {
  key: string;
  label: string;
  dashed?: boolean;
  /** CSS color; defaults to the chart palette by position. */
  color?: string;
}

/**
 * One point on the x axis. `bucket` is the start of the hour, day, week or
 * month it counts (the result's `bucket`, `2026-03-01`): set it and the chart
 * can place annotations and add one on click.
 */
export type ChartDatum = { label: string; bucket?: string } & Record<string, string | number | null>;

interface TimeSeriesChartProps {
  data: ChartDatum[];
  series: ChartSeries[];
  type?: 'line' | 'bar';
  locale: string;
  className?: string;
  /** Hide the legend for a single series. */
  legend?: boolean;
  /** Horizontal lines at fixed values (an alert's threshold or band), labelled. */
  guides?: { value: number; label: string }[];
}

export function seriesColor(index: number): string {
  return `var(--chart-${(index % 5) + 1})`;
}

interface AnnotationMark {
  label: string;
  title: string;
}

interface ChartBodyProps extends TimeSeriesChartProps {
  marks?: AnnotationMark[];
  onPickIndex?: (index: number) => void;
  onPickMark?: () => void;
}

function MarkLabel({ viewBox, title, onPick }: Readonly<{ viewBox?: { x?: number; y?: number }; title: string; onPick?: () => void }>) {
  if (viewBox?.x === undefined || viewBox.y === undefined) return null;
  return (
    <g
      transform={`translate(${viewBox.x}, ${viewBox.y + 4})`}
      className={onPick ? 'cursor-pointer' : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onPick?.();
      }}
      data-testid="weldpanel-annotation-marker"
    >
      <title>{title}</title>
      <circle r={5} fill="var(--primary)" stroke="var(--background)" strokeWidth={1.5} />
    </g>
  );
}

function ChartBody({ data, series, type = 'line', locale, className, legend, guides = [], marks = [], onPickIndex, onPickMark }: Readonly<ChartBodyProps>) {
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: s.color ?? seriesColor(i) }]));
  const showLegend = legend ?? series.length > 1;
  const onClick = onPickIndex
    ? (state: MouseHandlerDataParam) => {
        const index = Number(state.activeTooltipIndex);
        if (Number.isInteger(index) && index >= 0 && index < data.length) onPickIndex(index);
      }
    : undefined;
  const common = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
      <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v: number) => formatCompact(v, locale)} />
      <ChartTooltip content={<ChartTooltipContent formatter={(value) => <span className="font-mono font-medium tabular-nums">{formatNumber(Number(value), locale)}</span>} />} />
      {showLegend && <ChartLegend content={<ChartLegendContent />} />}
      {guides.map((guide) => (
        <ReferenceLine
          key={`guide:${guide.label}`}
          y={guide.value}
          stroke="var(--destructive)"
          strokeDasharray="4 4"
          ifOverflow="extendDomain"
          label={{ value: guide.label, position: 'insideTopRight', fill: 'var(--muted-foreground)', fontSize: 11 }}
        />
      ))}
      {marks.map((mark) => (
        <ReferenceLine
          key={`mark:${mark.label}`}
          x={mark.label}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          ifOverflow="extendDomain"
          label={(props: { viewBox?: { x?: number; y?: number } }) => <MarkLabel viewBox={props.viewBox} title={mark.title} onPick={onPickMark} />}
        />
      ))}
    </>
  );

  return (
    <ChartContainer config={config} className={cn('aspect-auto h-64 w-full', onPickIndex && 'cursor-crosshair', className)}>
      {type === 'bar' ? (
        <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }} onClick={onClick}>
          {common}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={[3, 3, 0, 0]} fillOpacity={s.dashed ? 0.45 : 1} />
          ))}
        </BarChart>
      ) : (
        <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }} onClick={onClick}>
          {common}
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={`var(--color-${s.key})`}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '4 4' : undefined}
              dot={data.length <= 2}
              isAnimationActive={false}
              connectNulls
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}

/** The chart with the annotations of its range; only mounted where annotations are on. */
function AnnotatedChart({ scope, ...props }: Readonly<TimeSeriesChartProps & { scope: ChartAnnotationsScope }>) {
  const { project } = useCurrentProject();
  const params = useSearchParams();
  const canCreate = useCan('panel_reports:create');
  const projectId = scope.projectId ?? project?.id ?? '';
  const reportId = scope.reportId === undefined ? params.get('report') || null : scope.reportId;
  const buckets = useMemo(() => props.data.map((d) => d.bucket ?? ''), [props.data]);
  const range = useMemo(() => bucketRange(buckets), [buckets]);
  const query = useMemo(() => ({ projectId, ...(range ?? {}), ...(reportId ? { reportId } : {}) }), [projectId, range, reportId]);
  const { data: annotations } = useWeldPanelAnnotations(query, range !== null);
  const [creatingAt, setCreatingAt] = useState<string | null>(null);
  const [listing, setListing] = useState(false);

  const marks = useMemo<AnnotationMark[]>(() => {
    if (!annotations || annotations.length === 0) return [];
    const byBucket = annotationsByBucket<PanelAnnotationDto>(buckets, annotations);
    return [...byBucket.entries()]
      .map(([index, list]) => ({ label: props.data[index]?.label ?? '', title: list.map((a) => a.label).join('\n') }))
      .filter((m) => m.label !== '');
  }, [annotations, buckets, props.data]);

  const pickable = canCreate && projectId !== '' && range !== null;
  let dialogs: ReactNode = null;
  if (projectId !== '' && (creatingAt !== null || listing)) {
    dialogs = (
      <Suspense fallback={null}>
        {creatingAt !== null && (
          <AnnotationEditDialog open onOpenChange={(open) => !open && setCreatingAt(null)} projectId={projectId} reportId={reportId} defaultOccurredAt={creatingAt} />
        )}
        {listing && <AnnotationsListDialog open onOpenChange={setListing} projectId={projectId} reportId={reportId} from={range?.from} to={range?.to} />}
      </Suspense>
    );
  }

  return (
    <>
      <ChartBody
        {...props}
        marks={marks}
        onPickIndex={pickable ? (index) => setCreatingAt(annotationTimeForBucket(buckets[index] ?? '')) : undefined}
        onPickMark={() => setListing(true)}
      />
      {dialogs}
    </>
  );
}

export function TimeSeriesChart(props: Readonly<TimeSeriesChartProps>) {
  const scope = useChartAnnotationsScope();
  const placeable = props.data.some((d) => typeof d.bucket === 'string' && d.bucket !== '');
  if (!scope || !placeable) return <ChartBody {...props} />;
  return <AnnotatedChart {...props} scope={scope} />;
}
