/**
 * One WeldReach campaign: header with status and Launch / Pause / Resume,
 * then the Sequence, Prospects, Mailboxes, Schedule & settings and Stats tabs.
 *
 * The API validates a launch (an active mailbox, a sender identity, steps and
 * prospects) and its message is shown as is, so the user sees exactly what is
 * missing.
 */

import { useState } from 'react';
import {
  BarChart3,
  CalendarClock,
  ListOrdered,
  Loader2,
  Mail,
  Pause,
  Play,
  Rocket,
  Users,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { PageTab } from '@weldsuite/ui/components/page-tabs';
import type { ReachCampaignDetail } from '@weldsuite/app-api-client/schemas/reach';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import {
  useLaunchReachCampaign,
  usePauseReachCampaign,
  useReachCampaign,
  useResumeReachCampaign,
} from '@/hooks/queries/use-reach-campaign-queries';
import { CampaignStatusBadge } from '@/app/weldreach/components/engage/badges';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  DetailHeader,
  DetailTabs,
  ErrorBanner,
  Notice,
  TabBody,
  errorMessage,
  useReachBreadcrumbs,
} from '@/app/weldreach/components/engage/kit';
import { MailboxesTab } from './components/mailboxes-tab';
import { ProspectsTab } from './components/prospects-tab';
import { SequenceTab } from './components/sequence-tab';
import { SettingsTab } from './components/settings-tab';
import { StatsTab } from './components/stats-tab';

const TAB_IDS = ['sequence', 'prospects', 'mailboxes', 'settings', 'stats'] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return TAB_IDS.some((id) => id === value);
}

/** Why a campaign paused by itself, for the reasons reach-api records; anything else is shown as stored. */
const PAUSED_REASON_KEYS: Record<string, string> = {
  bounce_rate: 'reachEngage.campaign.pausedReasons.bounce_rate',
  mailbox_unhealthy: 'reachEngage.campaign.pausedReasons.mailbox_unhealthy',
  no_active_mailbox: 'reachEngage.campaign.pausedReasons.no_active_mailbox',
  billing: 'reachEngage.campaign.pausedReasons.billing',
  payment_failed: 'reachEngage.campaign.pausedReasons.billing',
  access_suspended: 'reachEngage.campaign.pausedReasons.access_suspended',
  kill_switch: 'reachEngage.campaign.pausedReasons.kill_switch',
  domain_expired: 'reachEngage.campaign.pausedReasons.domain_expired',
};

export default function ReachCampaignPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { data: campaign, isLoading, error } = useReachCampaign(campaignId);

  const t = useTranslations();
  const router = useRouter();
  useReachBreadcrumbs(
    { label: t('reachEngage.campaigns.title'), href: '/weldreach/campaigns' },
    campaign && { label: campaign.name },
  );

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!campaign) {
    return (
      <TabBody>
        <ErrorBanner error={errorMessage(error, t('reachEngage.campaign.loadFailed'))} />
        <Button variant="outline" size="sm" onClick={() => router.push('/weldreach/campaigns')}>
          {t('reachEngage.campaign.backToCampaigns')}
        </Button>
      </TabBody>
    );
  }

  return <CampaignDetail campaign={campaign} />;
}

function CampaignDetail({ campaign }: Readonly<{ campaign: ReachCampaignDetail }>) {
  const t = useTranslations();
  const router = useRouter();
  const format = useReachFormat();
  const { can } = usePermissions();
  const searchParams = useSearchParams();

  const requestedTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabId>(isTabId(requestedTab) ? requestedTab : 'sequence');
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingLaunch, setConfirmingLaunch] = useState(false);

  const launch = useLaunchReachCampaign(campaign.id);
  const pause = usePauseReachCampaign(campaign.id);
  const resume = useResumeReachCampaign(campaign.id);

  const canEdit = can('reach_campaigns:update');
  const busy = launch.isPending || pause.isPending || resume.isPending;

  function changeTab(next: string) {
    if (!isTabId(next)) return;
    setTab(next);
    router.replace(`/weldreach/campaigns/${campaign.id}?tab=${next}`);
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure(errorMessage(err, fallback));
    }
  }

  const tabs: PageTab[] = [
    { id: 'sequence', label: t('reachEngage.campaign.tabs.sequence'), icon: ListOrdered },
    {
      id: 'prospects',
      label: t('reachEngage.campaign.tabs.prospects'),
      icon: Users,
      count: campaign.stats.prospects,
    },
    {
      id: 'mailboxes',
      label: t('reachEngage.campaign.tabs.mailboxes'),
      icon: Mail,
      count: campaign.mailboxIds.length,
    },
    { id: 'settings', label: t('reachEngage.campaign.tabs.settings'), icon: CalendarClock },
    { id: 'stats', label: t('reachEngage.campaign.tabs.stats'), icon: BarChart3 },
  ];

  const pausedReasonKey = campaign.pausedReason ? PAUSED_REASON_KEYS[campaign.pausedReason] : undefined;
  const showPausedReason =
    campaign.status === 'paused' && campaign.pausedReason && campaign.pausedReason !== 'manual';

  const actions = canEdit ? (
    <>
      {campaign.status === 'draft' && (
        <Button size="sm" disabled={busy} onClick={() => setConfirmingLaunch(true)}>
          {launch.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Rocket className="mr-1.5 h-4 w-4" />
          )}
          {t('reachEngage.campaign.actions.launch')}
        </Button>
      )}
      {campaign.status === 'active' && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => pause.mutateAsync(), t('reachEngage.campaign.actions.pauseFailed'))}
        >
          {pause.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Pause className="mr-1.5 h-4 w-4" />
          )}
          {t('reachEngage.campaign.actions.pause')}
        </Button>
      )}
      {campaign.status === 'paused' && (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void run(() => resume.mutateAsync(), t('reachEngage.campaign.actions.resumeFailed'))}
        >
          {resume.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-1.5 h-4 w-4" />
          )}
          {t('reachEngage.campaign.actions.resume')}
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader
        title={campaign.name}
        badges={<CampaignStatusBadge status={campaign.status} />}
        subtitle={t('reachEngage.campaign.summary', {
          prospects: format.number(campaign.stats.prospects),
          steps: format.number(campaign.steps.length),
          mailboxes: format.number(campaign.mailboxIds.length),
        })}
        actions={actions}
        onBack={() => router.push('/weldreach/campaigns')}
      />

      {(failure || showPausedReason) && (
        <div className="space-y-2 px-6 pt-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
          {showPausedReason && (
            <Notice tone="warning" title={t('reachEngage.campaign.pausedTitle')}>
              {pausedReasonKey
                ? t(pausedReasonKey)
                : t('reachEngage.campaign.pausedOther', { reason: campaign.pausedReason ?? '' })}
            </Notice>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <DetailTabs tabs={tabs} activeTab={tab} onTabChange={changeTab}>
          {tab === 'sequence' && <SequenceTab campaign={campaign} canEdit={canEdit} />}
          {tab === 'prospects' && <ProspectsTab campaign={campaign} canEdit={canEdit} />}
          {tab === 'mailboxes' && <MailboxesTab campaign={campaign} canEdit={canEdit} />}
          {tab === 'settings' && <SettingsTab campaign={campaign} canEdit={canEdit} />}
          {tab === 'stats' && <StatsTab campaign={campaign} />}
        </DetailTabs>
      </div>

      <ConfirmDialog
        open={confirmingLaunch}
        onOpenChange={setConfirmingLaunch}
        title={t('reachEngage.campaign.launchConfirm.title')}
        description={t('reachEngage.campaign.launchConfirm.description', {
          prospects: format.number(campaign.stats.prospects),
          steps: format.number(campaign.steps.length),
        })}
        confirmLabel={t('reachEngage.campaign.actions.launch')}
        cancelLabel={t('reachEngage.common.cancel')}
        onConfirm={async () => {
          await run(() => launch.mutateAsync(), t('reachEngage.campaign.actions.launchFailed'));
          setConfirmingLaunch(false);
        }}
      />
    </div>
  );
}
