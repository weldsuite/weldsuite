import type { ReactElement } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type PieLabelRenderProps,
} from 'recharts';
import type { ChartDataPoint } from '@/app/weldflow/lib/api-client';
import { formatMetricValue, metricUnit } from '../lib/metric-units';

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export interface AnalyticsChartViewProps {
  points: ChartDataPoint[];
  /** Builder chart type id, e.g. `area-chart`, `bar-mixed`, `pie-donut`, `radar-lines`. */
  chartType: string;
  /** Metric id; percentage metrics get a % unit on axes, tooltips and labels. */
  metric?: string;
  color: string;
  showLegend?: boolean;
  smoothCurve?: boolean;
  fillArea?: boolean;
  showDataLabels?: boolean;
  /** Sizing of the chart container. */
  className?: string;
}

function pieLabel(props: PieLabelRenderProps): string {
  return `${props.name ?? ''} ${((props.percent ?? 0) * 100).toFixed(0)}%`;
}

/** What every chart variant below needs; the view resolves it once. */
interface ChartParts {
  props: AnalyticsChartViewProps;
  type: string;
  formatValue: (value: unknown) => string;
}

function AreaVariant({ props, formatValue }: Readonly<ChartParts>) {
  const { points, color, smoothCurve = true, fillArea = true, showDataLabels = false } = props;
  return (
    <AreaChart data={points} margin={{ left: 12, right: 12 }}>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
      <YAxis tick={{ fontSize: 12 }} tickFormatter={formatValue} />
      <Tooltip formatter={formatValue} />
      <Area
        dataKey="value"
        type={smoothCurve ? 'monotone' : 'linear'}
        stroke={color}
        strokeWidth={2}
        fill={fillArea ? color : 'transparent'}
        fillOpacity={fillArea ? 0.2 : 0}
        dot={showDataLabels}
      />
    </AreaChart>
  );
}

function PieVariant({ props, type, formatValue }: Readonly<ChartParts>) {
  const { points, showLegend = false, showDataLabels = false } = props;
  return (
    <PieChart>
      <Pie
        data={points}
        dataKey="value"
        nameKey="label"
        innerRadius={type.includes('donut') ? 50 : 0}
        outerRadius={90}
        label={showDataLabels ? pieLabel : false}
      >
        {points.map((point, index) => (
          <Cell key={point.label} fill={point.fill || PALETTE[index % PALETTE.length]} />
        ))}
      </Pie>
      <Tooltip formatter={formatValue} />
      {showLegend && <Legend />}
    </PieChart>
  );
}

function RadarVariant({ props, formatValue }: Readonly<ChartParts>) {
  const { points, color } = props;
  return (
    <RadarChart data={points}>
      <PolarGrid />
      <PolarAngleAxis dataKey="label" tick={{ fontSize: 12 }} />
      <Tooltip formatter={formatValue} />
      <Radar dataKey="value" stroke={color} fill={color} fillOpacity={0.3} />
    </RadarChart>
  );
}

function RadialVariant({ props, formatValue }: Readonly<ChartParts>) {
  const { points, showLegend = false, showDataLabels = false } = props;
  return (
    <RadialBarChart
      data={points.map((p, i) => ({ ...p, fill: p.fill || PALETTE[i % PALETTE.length] }))}
      innerRadius="20%"
      outerRadius="90%"
    >
      <RadialBar dataKey="value" background label={showDataLabels ? { position: 'insideStart', fill: '#fff' } : false} />
      <Tooltip formatter={formatValue} />
      {showLegend && <Legend />}
    </RadialBarChart>
  );
}

function BarVariant({ props, type, formatValue }: Readonly<ChartParts>) {
  const { points, color } = props;
  const horizontalBars = type.includes('mixed');
  return (
    <BarChart data={points} layout={horizontalBars ? 'vertical' : 'horizontal'}>
      <CartesianGrid vertical={false} />
      {horizontalBars ? (
        <>
          <XAxis type="number" tick={{ fontSize: 12 }} tickFormatter={formatValue} />
          <YAxis type="category" dataKey="label" tick={{ fontSize: 12 }} width={90} />
        </>
      ) : (
        <>
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={formatValue} />
        </>
      )}
      <Tooltip formatter={formatValue} />
      <Bar dataKey="value" fill={color} radius={4} />
    </BarChart>
  );
}

/** The chart variant a builder chart type id selects (bar is the fallback). */
function chartFor(parts: ChartParts): ReactElement {
  const { type } = parts;
  if (type.startsWith('area')) return <AreaVariant {...parts} />;
  if (type.startsWith('pie')) return <PieVariant {...parts} />;
  if (type.startsWith('radar')) return <RadarVariant {...parts} />;
  if (type.startsWith('radial')) return <RadialVariant {...parts} />;
  return <BarVariant {...parts} />;
}

/**
 * The one place that turns chart data into a recharts chart. The builder preview, the
 * workspace report page and the project report page all render through it, so a chart
 * looks the same in the builder as on the report it is saved to.
 */
export function AnalyticsChartView(props: Readonly<AnalyticsChartViewProps>) {
  const { chartType, metric, className = 'h-72 w-full' } = props;
  const unit = metricUnit(metric);
  const chart = chartFor({
    props,
    type: chartType.toLowerCase(),
    formatValue: (value: unknown) => formatMetricValue(value, unit),
  });

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height="100%">
        {chart}
      </ResponsiveContainer>
    </div>
  );
}
