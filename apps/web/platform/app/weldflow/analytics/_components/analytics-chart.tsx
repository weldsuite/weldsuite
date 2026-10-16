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

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export interface AnalyticsChartViewProps {
  points: ChartDataPoint[];
  /** Builder chart type id, e.g. `area-chart`, `bar-mixed`, `pie-donut`, `radar-lines`. */
  chartType: string;
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

/**
 * The one place that turns chart data into a recharts chart. The builder preview, the
 * workspace report page and the project report page all render through it, so a chart
 * looks the same in the builder as on the report it is saved to.
 */
export function AnalyticsChartView({
  points,
  chartType,
  color,
  showLegend = false,
  smoothCurve = true,
  fillArea = true,
  showDataLabels = false,
  className = 'h-72 w-full',
}: Readonly<AnalyticsChartViewProps>) {
  const type = chartType.toLowerCase();
  let chart: ReactElement;

  if (type.startsWith('area')) {
    chart = (
      <AreaChart data={points} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
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
  } else if (type.startsWith('pie')) {
    chart = (
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
        <Tooltip />
        {showLegend && <Legend />}
      </PieChart>
    );
  } else if (type.startsWith('radar')) {
    chart = (
      <RadarChart data={points}>
        <PolarGrid />
        <PolarAngleAxis dataKey="label" tick={{ fontSize: 12 }} />
        <Tooltip />
        <Radar dataKey="value" stroke={color} fill={color} fillOpacity={0.3} />
      </RadarChart>
    );
  } else if (type.startsWith('radial')) {
    chart = (
      <RadialBarChart
        data={points.map((p, i) => ({ ...p, fill: p.fill || PALETTE[i % PALETTE.length] }))}
        innerRadius="20%"
        outerRadius="90%"
      >
        <RadialBar dataKey="value" background label={showDataLabels ? { position: 'insideStart', fill: '#fff' } : false} />
        <Tooltip />
        {showLegend && <Legend />}
      </RadialBarChart>
    );
  } else {
    const horizontalBars = type.includes('mixed');
    chart = (
      <BarChart data={points} layout={horizontalBars ? 'vertical' : 'horizontal'}>
        <CartesianGrid vertical={false} />
        {horizontalBars ? (
          <>
            <XAxis type="number" tick={{ fontSize: 12 }} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 12 }} width={90} />
          </>
        ) : (
          <>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
          </>
        )}
        <Tooltip />
        <Bar dataKey="value" fill={color} radius={4} />
      </BarChart>
    );
  }

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height="100%">
        {chart}
      </ResponsiveContainer>
    </div>
  );
}
