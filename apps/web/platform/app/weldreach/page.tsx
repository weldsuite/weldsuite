/**
 * WeldReach overview: today's and the last week's numbers, a 14 day chart,
 * mailbox health, and, until onboarding is completed, a prominent card that
 * leads to the setup wizard.
 */

import { Inbox, MailCheck, Percent, Reply, Rocket, Send, Sparkles, Star, TriangleAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { WELDREACH_SENDING_DEFAULTS } from '@weldsuite/app-api-client/schemas/reach';
import { PageLoader } from '@/components/page-loader';
import { Link } from '@/lib/router';
import { useReachAccess, useReachOverview, useReachSettings } from '@/hooks/queries/use-reach-queries';
import { useReachFormat } from '@/lib/reach/format';
import { ActivityChart } from './components/activity-chart';
import {
  DashboardPage,
  EmptyText,
  ErrorPanel,
  KpiCard,
  KpiGrid,
  SectionCard,
  useReachBreadcrumbs,
} from './components/page-kit';

/** Bounce rate above which the campaign guardrail pauses a campaign. */
const BOUNCE_WARNING_RATE = WELDREACH_SENDING_DEFAULTS.campaignBounceRate;

export default function ReachOverviewPage() {
  const t = useTranslations();
  const format = useReachFormat();
  const { can } = usePermissions();
  useReachBreadcrumbs();

  const canReadSettings = can('reach_settings:read');
  const overview = useReachOverview();
  const access = useReachAccess();
  const settings = useReachSettings(canReadSettings);

  if (overview.isPending) return <PageLoader fullScreen={false} label={t('reach.common.loading')} />;
  if (overview.isError || !overview.data) {
    return (
      <DashboardPage title={t('reach.overview.title')}>
        <ErrorPanel onRetry={() => void overview.refetch()} />
      </DashboardPage>
    );
  }

  const data = overview.data;
  const maxDailySends = access.data?.limits.maxDailySends;
  const showSetupCard =
    can('reach_settings:update') && settings.data !== undefined && settings.data.onboardingCompletedAt === null;
  const hasActivity = data.daily.some((day) => day.sent > 0 || day.replies > 0);
  const mailboxTotal =
    data.mailboxes.active + data.mailboxes.warming + data.mailboxes.paused + data.mailboxes.error;

  return (
    <DashboardPage title={t('reach.overview.title')} description={t('reach.overview.description')}>
      {showSetupCard && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex min-w-0 items-start gap-3">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{t('reach.overview.setupCard.title')}</h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  {t('reach.overview.setupCard.description', { days: WELDREACH_SENDING_DEFAULTS.warmupDays })}
                </p>
              </div>
            </div>
            <Button asChild>
              <Link href="/weldreach/setup">{t('reach.overview.setupCard.cta')}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <KpiGrid>
        <KpiCard
          label={t('reach.overview.tiles.sentToday')}
          value={format.number(data.sentToday)}
          icon={Send}
          hint={
            maxDailySends === undefined
              ? undefined
              : t('reach.overview.hints.sentTodayOf', { limit: format.number(maxDailySends) })
          }
        />
        <KpiCard
          label={t('reach.overview.tiles.sent7d')}
          value={format.number(data.sent7d)}
          icon={MailCheck}
        />
        <KpiCard
          label={t('reach.overview.tiles.replies7d')}
          value={format.number(data.replies7d)}
          icon={Reply}
        />
        <KpiCard
          label={t('reach.overview.tiles.interested7d')}
          value={format.number(data.interested7d)}
          icon={Star}
          tone={data.interested7d > 0 ? 'success' : 'default'}
        />
        <KpiCard
          label={t('reach.overview.tiles.replyRate')}
          value={format.percent(data.replyRate7d)}
          icon={Percent}
          hint={t('reach.overview.hints.last7d')}
        />
        <KpiCard
          label={t('reach.overview.tiles.bounceRate')}
          value={format.percent(data.bounceRate7d)}
          icon={TriangleAlert}
          tone={data.bounceRate7d > BOUNCE_WARNING_RATE ? 'warning' : 'default'}
          hint={
            data.bounceRate7d > BOUNCE_WARNING_RATE
              ? t('reach.overview.hints.bounceHigh')
              : t('reach.overview.hints.last7d')
          }
        />
        <KpiCard
          label={t('reach.overview.tiles.activeCampaigns')}
          value={format.number(data.activeCampaigns)}
          icon={Rocket}
          href={can('reach_campaigns:read') ? '/weldreach/campaigns' : undefined}
        />
        <KpiCard
          label={t('reach.overview.tiles.unreadReplies')}
          value={format.number(data.unreadReplies)}
          icon={Inbox}
          tone={data.unreadReplies > 0 ? 'warning' : 'default'}
          hint={can('reach_inbox:read') ? t('reach.overview.hints.openInbox') : undefined}
          href={can('reach_inbox:read') ? '/weldreach/inbox' : undefined}
        />
      </KpiGrid>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title={t('reach.overview.chart.title')}
          description={t('reach.overview.chart.description')}
        >
          {hasActivity ? <ActivityChart daily={data.daily} /> : <EmptyText>{t('reach.overview.chart.empty')}</EmptyText>}
        </SectionCard>

        <SectionCard title={t('reach.overview.health.title')} description={t('reach.overview.health.description')}>
          {mailboxTotal === 0 ? (
            <EmptyText>{t('reach.overview.health.empty')}</EmptyText>
          ) : (
            <ul className="space-y-3 text-sm">
              <HealthRow tone="bg-emerald-500" label={t('reach.overview.health.active')} count={data.mailboxes.active} />
              <HealthRow tone="bg-amber-500" label={t('reach.overview.health.warming')} count={data.mailboxes.warming} />
              <HealthRow tone="bg-muted-foreground/50" label={t('reach.overview.health.paused')} count={data.mailboxes.paused} />
              <HealthRow tone="bg-destructive" label={t('reach.overview.health.error')} count={data.mailboxes.error} />
            </ul>
          )}
          {can('reach_mailboxes:read') && (
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link href="/weldreach/mailboxes">
                {mailboxTotal === 0 ? t('reach.overview.health.addFirst') : t('reach.overview.health.manage')}
              </Link>
            </Button>
          )}
        </SectionCard>
      </div>
    </DashboardPage>
  );
}

function HealthRow({ tone, label, count }: Readonly<{ tone: string; label: string; count: number }>) {
  const format = useReachFormat();
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${tone}`} aria-hidden />
        {label}
      </span>
      <span className="font-medium tabular-nums">{format.number(count)}</span>
    </li>
  );
}
