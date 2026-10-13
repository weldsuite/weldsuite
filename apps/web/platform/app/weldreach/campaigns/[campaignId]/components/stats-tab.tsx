/** The Stats tab: campaign totals and what each step sent, drew in and bounced. */

import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@weldsuite/ui/components/chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachCampaignDetail } from '@weldsuite/app-api-client/schemas/reach';
import { useReachStepStats } from '@/hooks/queries/use-reach-campaign-queries';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  EmptyText,
  ErrorBanner,
  InlineSpinner,
  SectionCard,
  TabBody,
  errorMessage,
} from '@/app/weldreach/components/engage/kit';

function Kpi({
  label,
  value,
  hint,
}: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <Card className="py-0">
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function StepStatsBody({ campaignId }: Readonly<{ campaignId: string }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const stepStats = useReachStepStats(campaignId);

  const chartConfig = useMemo(
    () =>
      ({
        sent: { label: t('reachEngage.stats.sent'), color: 'var(--chart-1)' },
        replied: { label: t('reachEngage.stats.replied'), color: 'var(--chart-2)' },
        bounced: { label: t('reachEngage.stats.bounced'), color: 'var(--chart-3)' },
      }) satisfies ChartConfig,
    [t],
  );

  const rows = useMemo(
    () =>
      [...(stepStats.data ?? [])]
        .sort((a, b) => a.order - b.order)
        .map((row, index) => ({
          ...row,
          name: t('reachEngage.stats.stepName', { number: index + 1 }),
        })),
    [stepStats.data, t],
  );

  if (stepStats.isLoading) return <InlineSpinner />;
  if (stepStats.isError) {
    return <ErrorBanner error={errorMessage(stepStats.error, t('reachEngage.stats.loadFailed'))} />;
  }
  if (rows.length === 0) return <EmptyText>{t('reachEngage.stats.empty')}</EmptyText>;

  return (
    <div className="space-y-6">
      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
        <BarChart data={rows} margin={{ left: 4, right: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="sent" fill="var(--color-sent)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="replied" fill="var(--color-replied)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="bounced" fill="var(--color-bounced)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('reachEngage.stats.step')}</TableHead>
            <TableHead className="text-right">{t('reachEngage.stats.sent')}</TableHead>
            <TableHead className="text-right">{t('reachEngage.stats.replied')}</TableHead>
            <TableHead className="text-right">{t('reachEngage.stats.replyRate')}</TableHead>
            <TableHead className="text-right">{t('reachEngage.stats.bounced')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.stepId}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="text-right tabular-nums">{format.number(row.sent)}</TableCell>
              <TableCell className="text-right tabular-nums">{format.number(row.replied)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {row.sent > 0 ? format.percent(row.replied / row.sent) : '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">{format.number(row.bounced)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function StatsTab({ campaign }: Readonly<{ campaign: ReachCampaignDetail }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const { stats } = campaign;

  const rate = (part: number) => (stats.sent > 0 ? format.percent(part / stats.sent) : '—');

  return (
    <TabBody>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label={t('reachEngage.stats.prospects')} value={format.number(stats.prospects)} />
        <Kpi label={t('reachEngage.stats.sent')} value={format.number(stats.sent)} />
        <Kpi
          label={t('reachEngage.stats.replied')}
          value={format.number(stats.replied)}
          hint={t('reachEngage.stats.ofSent', { rate: rate(stats.replied) })}
        />
        <Kpi
          label={t('reachEngage.stats.interested')}
          value={format.number(stats.interested)}
          hint={t('reachEngage.stats.ofSent', { rate: rate(stats.interested) })}
        />
        <Kpi
          label={t('reachEngage.stats.bounced')}
          value={format.number(stats.bounced)}
          hint={t('reachEngage.stats.ofSent', { rate: rate(stats.bounced) })}
        />
        <Kpi label={t('reachEngage.stats.unsubscribed')} value={format.number(stats.unsubscribed)} />
      </div>

      <SectionCard title={t('reachEngage.stats.perStepTitle')} description={t('reachEngage.stats.perStepDescription')}>
        <StepStatsBody campaignId={campaign.id} />
      </SectionCard>
    </TabBody>
  );
}
