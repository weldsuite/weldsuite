/**
 * Annotations on any WeldPanel chart over dates, like TradingView's events:
 * round markers along the bottom of the plot (a note icon, or the number of
 * notes when a date has several). Hovering or focusing a marker draws a line
 * up through the chart and a card with the notes, clicking it lists them, and
 * clicking a date on the chart adds one there.
 *
 * A chart wraps its body in `ChartAnnotations` with its rows; rows that carry
 * their `bucket` (the start of the hour, day, week or month) get markers where
 * the WeldPanel layout turns annotations on (`ChartAnnotationsProvider`).
 * Elsewhere (the public share page, a chart over something other than dates,
 * a test rendering a view on its own) the body gets `NO_CHART_ANNOTATIONS`
 * and nothing is requested. Inside the chart it renders
 * `annotationMarkLines(api)`, passes `annotationChartClick(api, rows)` as the
 * chart's `onClick` and hides its own tooltip while a marker is hovered
 * (`annotationTooltipActive(api)`).
 */

import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from 'react';
import { StickyNote } from 'lucide-react';
import { ReferenceLine, type MouseHandlerDataParam } from 'recharts';
import type { PanelAnnotationDto } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { useCan } from '@weldsuite/permissions/react';
import { useWeldPanelAnnotations } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useSearchParams } from '@/lib/router';
import { annotationTimeForBucket, annotationsByBucket, bucketRange } from '../../lib/annotations';
import { formatDateTime } from '../../lib/format';
import { useCurrentProject } from '../../lib/use-current-project';
import { useChartAnnotationsScope, type ChartAnnotationsScope } from './annotations-context';

// Loaded when opened, so a chart costs nothing extra until someone annotates it.
const AnnotationEditDialog = lazy(() => import('../annotation-dialogs').then((m) => ({ default: m.AnnotationEditDialog })));
const AnnotationsListDialog = lazy(() => import('../annotation-dialogs').then((m) => ({ default: m.AnnotationsListDialog })));

/** Radius of a marker; it sits this far plus a little above the bottom of the plot. */
const MARK_RADIUS = 10;
/** Width of the hover card, to keep it inside the chart near the edges. */
const CARD_WIDTH = 256;

/** A row of a chart over dates: its x-axis label and, to place annotations, its `bucket`. */
export interface AnnotatableRow {
  label: string;
  bucket?: string | number | null;
}

export interface AnnotationMark {
  /** The x-axis label of the date the notes fall in. */
  label: string;
  annotations: PanelAnnotationDto[];
}

export interface HoveredMark {
  label: string;
  x: number;
  y: number;
}

export interface ChartAnnotationsApi {
  marks: AnnotationMark[];
  hoveredMark?: AnnotationMark;
  setHovered: (hovered: HoveredMark | null) => void;
  /** Add an annotation at the row clicked; absent when it may not be done here. */
  onPickIndex?: (index: number) => void;
  /** List the annotations (a marker was clicked). */
  onPickMark?: () => void;
}

export const NO_CHART_ANNOTATIONS: ChartAnnotationsApi = { marks: [], setHovered: () => undefined };

function hasBuckets(rows: readonly AnnotatableRow[]): boolean {
  return rows.some((row) => typeof row.bucket === 'string' && row.bucket !== '');
}

interface MarkBadgeProps {
  viewBox?: { x?: number; y?: number; height?: number };
  mark: AnnotationMark;
  active: boolean;
  onHover: (hovered: HoveredMark | null) => void;
  onPick?: () => void;
}

function MarkBadge({ viewBox, mark, active, onHover, onPick }: Readonly<MarkBadgeProps>) {
  const { t } = useI18n();
  if (viewBox?.x === undefined || viewBox.y === undefined || viewBox.height === undefined) return null;
  const x = viewBox.x;
  const y = viewBox.y + viewBox.height - MARK_RADIUS - 4;
  const count = mark.annotations.length;
  const show = () => onHover({ label: mark.label, x, y });
  const hide = () => onHover(null);
  return (
    <g
      transform={`translate(${x}, ${y})`}
      role="button"
      tabIndex={0}
      aria-label={`${t.weldpanel.collab.annotations.button}: ${mark.annotations.map((a) => a.label).join(', ')}`}
      className="cursor-pointer outline-none"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(event) => {
        event.stopPropagation();
        onPick?.();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPick?.();
      }}
      data-testid="weldpanel-annotation-marker"
    >
      <circle r={MARK_RADIUS} fill="var(--background)" stroke="var(--primary)" strokeWidth={active ? 2 : 1.5} />
      {count > 1 ? (
        <text textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={600} fill="var(--primary)">
          {count}
        </text>
      ) : (
        <StickyNote x={-5.5} y={-5.5} width={11} height={11} color="var(--primary)" strokeWidth={2.25} aria-hidden />
      )}
    </g>
  );
}

/** The markers, as reference lines (drawn only while hovered) carrying them: render inside the recharts chart. */
export function annotationMarkLines(api: ChartAnnotationsApi): ReactNode[] {
  return api.marks.map((mark) => (
    <ReferenceLine
      key={`mark:${mark.label}`}
      x={mark.label}
      stroke={api.hoveredMark === mark ? 'var(--muted-foreground)' : 'transparent'}
      strokeDasharray="3 3"
      ifOverflow="extendDomain"
      label={(props: { viewBox?: MarkBadgeProps['viewBox'] }) => (
        <MarkBadge viewBox={props.viewBox} mark={mark} active={api.hoveredMark === mark} onHover={api.setHovered} onPick={api.onPickMark} />
      )}
    />
  ));
}

/** The chart's `onClick`: add an annotation at the row clicked, where that may be done. */
export function annotationChartClick(api: ChartAnnotationsApi, rows: readonly unknown[]): ((state: MouseHandlerDataParam) => void) | undefined {
  const pick = api.onPickIndex;
  if (!pick) return undefined;
  return (state) => {
    // No active point (a click off the data) is not the first row.
    if (state.activeTooltipIndex === null || state.activeTooltipIndex === undefined) return;
    const index = Number(state.activeTooltipIndex);
    if (Number.isInteger(index) && index >= 0 && index < rows.length) pick(index);
  };
}

/** The chart tooltip's `active`: hidden while a marker's card shows. */
export function annotationTooltipActive(api: ChartAnnotationsApi): false | undefined {
  return api.hoveredMark ? false : undefined;
}

/** What a marker stands for, above it while it is hovered or focused. */
function MarkCard({ mark, at, chartWidth, locale }: Readonly<{ mark: AnnotationMark; at: HoveredMark; chartWidth: number; locale: string }>) {
  const left = Math.min(Math.max(at.x - CARD_WIDTH / 2, 0), Math.max(chartWidth - CARD_WIDTH, 0));
  return (
    <div
      className="pointer-events-none absolute z-10 grid gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-xl"
      style={{ left, top: at.y - MARK_RADIUS - 6, width: CARD_WIDTH, transform: 'translateY(-100%)' }}
    >
      {mark.annotations.map((annotation) => (
        <div key={annotation.id} className="grid gap-0.5">
          <p className="font-medium text-foreground">{annotation.label}</p>
          {annotation.description && <p className="line-clamp-2 text-muted-foreground">{annotation.description}</p>}
          <p className="text-muted-foreground">{formatDateTime(annotation.occurredAt, locale)}</p>
        </div>
      ))}
    </div>
  );
}

interface ChartAnnotationsProps {
  rows: readonly AnnotatableRow[];
  children: (api: ChartAnnotationsApi) => ReactNode;
}

/** The annotations of the chart's date range for its body; only fetched where they are on and the rows carry dates. */
export function ChartAnnotations({ rows, children }: Readonly<ChartAnnotationsProps>) {
  const scope = useChartAnnotationsScope();
  if (!scope || !hasBuckets(rows)) return <>{children(NO_CHART_ANNOTATIONS)}</>;
  return (
    <AnnotatedFrame scope={scope} rows={rows}>
      {children}
    </AnnotatedFrame>
  );
}

function AnnotatedFrame({ scope, rows, children }: Readonly<ChartAnnotationsProps & { scope: ChartAnnotationsScope }>) {
  const { language } = useI18n();
  const { project } = useCurrentProject();
  const params = useSearchParams();
  const canCreate = useCan('panel_reports:create');
  const projectId = scope.projectId ?? project?.id ?? '';
  const reportId = scope.reportId === undefined ? params.get('report') || null : scope.reportId;
  const buckets = useMemo(() => rows.map((row) => (typeof row.bucket === 'string' ? row.bucket : '')), [rows]);
  const range = useMemo(() => bucketRange(buckets), [buckets]);
  const query = useMemo(() => ({ projectId, ...(range ?? {}), ...(reportId ? { reportId } : {}) }), [projectId, range, reportId]);
  const { data: annotations } = useWeldPanelAnnotations(query, range !== null);
  const [creatingAt, setCreatingAt] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [hovered, setHovered] = useState<HoveredMark | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const marks = useMemo<AnnotationMark[]>(() => {
    if (!annotations || annotations.length === 0) return [];
    const byBucket = annotationsByBucket<PanelAnnotationDto>(buckets, annotations);
    return [...byBucket.entries()].map(([index, list]) => ({ label: rows[index]?.label ?? '', annotations: list })).filter((m) => m.label !== '');
  }, [annotations, buckets, rows]);
  const hoveredMark = hovered ? marks.find((m) => m.label === hovered.label) : undefined;

  const pickable = canCreate && projectId !== '' && range !== null;
  const api: ChartAnnotationsApi = {
    marks,
    hoveredMark,
    setHovered,
    onPickIndex: pickable ? (index) => setCreatingAt(annotationTimeForBucket(buckets[index] ?? '')) : undefined,
    onPickMark: () => setListing(true),
  };

  return (
    <div ref={wrapperRef} className="relative">
      {children(api)}
      {hoveredMark && hovered && <MarkCard mark={hoveredMark} at={hovered} chartWidth={wrapperRef.current?.clientWidth ?? 0} locale={language} />}
      {projectId !== '' && (creatingAt !== null || listing) && (
        <Suspense fallback={null}>
          {creatingAt !== null && (
            <AnnotationEditDialog open onOpenChange={(open) => !open && setCreatingAt(null)} projectId={projectId} reportId={reportId} defaultOccurredAt={creatingAt} />
          )}
          {listing && <AnnotationsListDialog open onOpenChange={setListing} projectId={projectId} reportId={reportId} from={range?.from} to={range?.to} />}
        </Suspense>
      )}
    </div>
  );
}
