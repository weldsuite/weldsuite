/**
 * This month's WeldPanel usage for the whole workspace: events and recordings
 * against the plan's allowance, the overage charged from the wallet, whether
 * collection is running, how long data is kept, and the split by project.
 * Reading the usage re-settles it on the server, so "Check again" after a
 * top-up lifts a block.
 */

import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { PanelUsageMeter } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Progress } from '@weldsuite/ui/components/progress';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useWeldPanelUsage } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { formatNumber, formatPercent } from '../lib/format';
import { meterTone, usageRatio } from '../lib/usage';

const TONE_BAR = { ok: 'bg-primary', warning: 'bg-amber-500', over: 'bg-destructive' } as const;

function Meter({ label, meter, hint }: Readonly<{ label: string; meter: PanelUsageMeter; hint: string }>) {
  const { t, language, format } = useI18n();
  const tu = t.weldpanel.observe.usage;
  const ratio = usageRatio(meter);
  const tone = meterTone(ratio);
  return (
    <div className="grid gap-2 rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="text-sm tabular-nums text-muted-foreground">{format(tu.of, { used: formatNumber(meter.used, language), allowance: formatNumber(meter.allowance, language) })}</span>
      </div>
      <Progress value={Math.min(100, ratio * 100)} aria-label={label} indicatorClassName={TONE_BAR[tone]} />
      <p className="text-xs text-muted-foreground">{tone === 'over' ? tu.overAllowance : format(tu.percentUsed, { percent: formatPercent(ratio, language, 0) })}</p>
      <p className="text-sm">
        {meter.blocksCharged > 0 ? format(tu.blocks, { count: formatNumber(meter.blocksCharged, language), credits: formatNumber(meter.creditsCharged, language) }) : tu.noOverage}
      </p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function UsageView() {
  const { t, language, format } = useI18n();
  const tu = t.weldpanel.observe.usage;
  const { data, isLoading, error, refetch, isFetching } = useWeldPanelUsage();

  if (error) return <ErrorState message={tu.loadFailed} onRetry={() => void refetch()} retryLabel={t.weldpanel.retry} />;
  if (isLoading || !data) return <Skeleton className="h-72 w-full" />;

  const blocked = data.quota !== 'ok';
  const [year = '', month = ''] = data.month.split('-');
  const monthLabel = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(year), Number(month) - 1, 1)));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{tu.title}</h2>
          <p className="text-sm text-muted-foreground">{tu.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SoftBadge tone="neutral">
            {tu.plan}: {data.planSlug}
          </SoftBadge>
          <SoftBadge tone="neutral">{monthLabel}</SoftBadge>
        </div>
      </div>

      <InfoBanner
        variant={blocked ? 'danger' : 'success'}
        title={tu.quotaBadges[data.quota]}
        action={
          <div className="flex flex-wrap gap-2">
            {blocked && (
              <Button asChild size="sm">
                <Link href="/settings/billing">{tu.topUp}</Link>
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch().then(() => toast.success(tu.refreshed))}>
              <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
              {tu.refresh}
            </Button>
          </div>
        }
      >
        {tu.quotas[data.quota]}
        {blocked && <span className="mt-1 block text-xs">{tu.refreshHint}</span>}
      </InfoBanner>

      <div className="grid gap-4 md:grid-cols-2">
        <Meter label={tu.events} meter={data.events} hint={tu.overageHintEvents} />
        <Meter label={tu.recordings} meter={data.recordings} hint={tu.overageHintRecordings} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/billing">{tu.topUp}</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/plans">{tu.upgrade}</Link>
        </Button>
      </div>

      <SectionCard title={tu.retention}>
        <ul className="grid gap-1 text-sm">
          <li>{format(tu.retentionEvents, { months: data.retention.eventsMonths })}</li>
          <li>{format(tu.retentionRecordings, { days: data.retention.recordingsDays })}</li>
          <li>{format(tu.retentionFavorites, { months: data.retention.favoritesMonths })}</li>
        </ul>
      </SectionCard>

      <SectionCard title={tu.perProject}>
        {data.projects.length === 0 ? (
          <EmptyText>{tu.noProjects}</EmptyText>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tu.projectCol}</TableHead>
                  <TableHead className="text-right">{tu.events}</TableHead>
                  <TableHead className="text-right">{tu.recordings}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.projects.map((project) => (
                  <TableRow key={project.projectId}>
                    <TableCell className="font-medium">{project.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(project.events, language)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(project.recordings, language)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
