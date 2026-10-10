import { useQuery } from '@tanstack/react-query';
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
} from 'recharts';
import { analyticsApi, type ChartDataPoint } from '@/app/weldflow/lib/api-client';
import { useI18n } from '@/lib/i18n/provider';

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export interface ChartPreviewQuery {
  entity: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  aggregation: string;
  sortOrder: string;
  limit?: number;
}

/** Loads the real data for the chart being configured in the builder. */
export function useChartPreviewData(reportId: string | null, query: ChartPreviewQuery) {
  const { entity, metric, timeRange, groupBy, aggregation, sortOrder, limit } = query;
  return useQuery({
    queryKey: ['weldflow', 'analytics', 'chart-preview', reportId, entity, metric, timeRange, groupBy, aggregation, sortOrder, limit],
    queryFn: async () => {
      const result = await analyticsApi.getChartsData(reportId ?? '', [
        { chartId: 'preview', entity, metric, timeRange, groupBy, aggregation, sortOrder, limit },
      ]);
      if (!result.success) throw new Error(result.error || 'Failed to load preview data');
      return result.data?.preview ?? [];
    },
    enabled: !!reportId && !!entity && !!metric,
    staleTime: 30_000,
  });
}

interface ChartPreviewProps {
  reportId: string | null;
  query: ChartPreviewQuery;
  chartType: string;
  color: string;
  showLegend: boolean;
  smoothCurve: boolean;
  fillArea: boolean;
  showDataLabels: boolean;
}

function Message({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="flex h-72 items-center justify-center text-sm text-muted-foreground text-center px-6">{children}</div>;
}

/** Preview of the chart being built, drawn from the workspace's real data. */
export function ChartPreview({
  reportId,
  query,
  chartType,
  color,
  showLegend,
  smoothCurve,
  fillArea,
  showDataLabels,
}: Readonly<ChartPreviewProps>) {
  const { t } = useI18n();
  const { data, isLoading, isError } = useChartPreviewData(reportId, query);

  if (!query.entity || !query.metric) return <Message>{t.projects.analyticsBuilder.previewSelectData}</Message>;
  if (isLoading) return <Message>{t.projects.analyticsReports.loadingData}</Message>;
  if (isError) return <Message>{t.projects.analyticsBuilder.previewFailed}</Message>;

  const points: ChartDataPoint[] = data ?? [];
  if (points.length === 0) return <Message>{t.projects.analyticsReports.noDataAvailable}</Message>;

  const type = chartType.toLowerCase();
  let chart: React.ReactElement;

  if (type.startsWith('area')) {
    chart = (
      <AreaChart data={points} margin={{ left: 12, right: 12 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Area
          dataKey="value"
          type={smoothCurve ? 'natural' : 'linear'}
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
          label={showDataLabels}
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
      <RadialBarChart data={points.map((p, i) => ({ ...p, fill: p.fill || PALETTE[i % PALETTE.length] }))} innerRadius="20%" outerRadius="90%">
        <RadialBar dataKey="value" background label={showDataLabels ? { position: 'insideStart', fill: '#fff' } : false} />
        <Tooltip />
        {showLegend && <Legend />}
      </RadialBarChart>
    );
  } else {
    chart = (
      <BarChart data={points} layout={type.includes('mixed') ? 'vertical' : 'horizontal'}>
        <CartesianGrid vertical={false} />
        {type.includes('mixed') ? (
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
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {chart}
      </ResponsiveContainer>
    </div>
  );
}
