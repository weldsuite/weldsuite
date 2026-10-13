/**
 * Small status displays for domains and mailboxes: badges, DNS check chips and
 * warmup progress and figures. Colour is never the only signal: every state also has a
 * label and, for checks, a check or cross icon.
 */

import { Check, Info, TriangleAlert, X } from 'lucide-react';
import { Progress } from '@weldsuite/ui/components/progress';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  WELDREACH_SENDING_DEFAULTS,
  type ReachDnsStatus,
  type ReachDomainStatus,
  type ReachMailbox,
  type ReachMailboxStatus,
  type ReachWarmupBlocker,
} from '@weldsuite/app-api-client/schemas/reach';
import { SoftBadge, type SoftTone } from '@/components/shared/soft-badge';
import { useReachFormat } from '@/lib/reach/format';
import { cn } from '@/lib/utils';
import {
  showsWarmupFigures,
  warmupBlockerSeverity,
  warmupCopyParams,
  warmupFigures,
  warmupStateToShow,
} from '../lib/warmup';

const MAILBOX_STATUS_TONE: Record<ReachMailboxStatus, SoftTone> = {
  provisioning: 'neutral',
  warming: 'warning',
  active: 'success',
  paused: 'neutral',
  suspended: 'danger',
  error: 'danger',
  deleting: 'neutral',
  deleted: 'neutral',
};

const DOMAIN_STATUS_TONE: Record<ReachDomainStatus, SoftTone> = {
  connecting: 'warning',
  active: 'success',
  error: 'danger',
  disconnecting: 'neutral',
};

export function MailboxStatusBadge({ status }: Readonly<{ status: ReachMailboxStatus }>) {
  const t = useTranslations();
  return <SoftBadge tone={MAILBOX_STATUS_TONE[status]}>{t(`reach.status.mailbox.${status}`)}</SoftBadge>;
}

export function DomainStatusBadge({ status }: Readonly<{ status: ReachDomainStatus }>) {
  const t = useTranslations();
  return <SoftBadge tone={DOMAIN_STATUS_TONE[status]}>{t(`reach.status.domain.${status}`)}</SoftBadge>;
}

const DNS_CHECKS = ['spf', 'dkim', 'dmarc', 'mx'] as const;

/** SPF, DKIM, DMARC and MX as four chips; `null` (never checked) shows a single hint. */
export function DnsChecks({ dns }: Readonly<{ dns: ReachDnsStatus | null }>) {
  const t = useTranslations();
  const format = useReachFormat();

  if (!dns) {
    return <span className="text-sm text-muted-foreground">{t('reach.mailboxes.domains.dns.unknown')}</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" title={t('reach.mailboxes.domains.dns.checkedAt', { time: format.relative(dns.checkedAt) })}>
      {DNS_CHECKS.map((check) => {
        const ok = dns[check];
        const label = t(`reach.mailboxes.domains.dns.${check}`);
        return (
          <span
            key={check}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
              ok
                ? 'border-transparent bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'border-transparent bg-destructive/10 text-destructive',
            )}
            title={t(ok ? 'reach.mailboxes.domains.dns.pass' : 'reach.mailboxes.domains.dns.fail', { check: label })}
          >
            {ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}
            {label}
            <span className="sr-only">
              {t(ok ? 'reach.mailboxes.domains.dns.pass' : 'reach.mailboxes.domains.dns.fail', { check: label })}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** "Day 6 of 14" with a progress bar while a mailbox warms up. */
export function WarmupProgress({ mailbox }: Readonly<{ mailbox: Pick<ReachMailbox, 'warmupDay' | 'status'> }>) {
  const t = useTranslations();
  if (mailbox.status !== 'warming') return null;

  const total = WELDREACH_SENDING_DEFAULTS.warmupDays;
  const day = Math.min(Math.max(mailbox.warmupDay, 0), total);
  return (
    <div className="w-32 space-y-1">
      <Progress value={(day / total) * 100} className="h-1.5" aria-label={t('reach.mailboxes.list.warmupProgress', { day, total })} />
      <p className="text-xs text-muted-foreground">{t('reach.mailboxes.list.warmupProgress', { day, total })}</p>
    </div>
  );
}

/** Why a warming mailbox cannot join campaigns yet, in a sentence; amber when it needs attention. */
export function WarmupBlockerNote({ blocker }: Readonly<{ blocker: ReachWarmupBlocker }>) {
  const t = useTranslations();
  const warning = warmupBlockerSeverity(blocker) === 'warning';
  const Icon = warning ? TriangleAlert : Info;
  return (
    <p
      className={cn(
        'flex max-w-56 items-start gap-1.5 text-xs',
        warning ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t(`reach.mailboxes.warmup.blockers.${blocker}`, warmupCopyParams())}</span>
    </p>
  );
}

/**
 * A mailbox's warmup at a glance: the day counter while warming, the pool state
 * when the status badge does not say it, inbox placement, warmup emails sent
 * and spam rescues over 7 days, and what holds a warming mailbox back. Ready
 * mailboxes keep their figures: warmup runs alongside campaigns.
 */
export function WarmupSummary({ mailbox }: Readonly<{ mailbox: ReachMailbox }>) {
  const t = useTranslations();
  const format = useReachFormat();

  if (!showsWarmupFigures(mailbox)) {
    return (
      <span className="text-sm text-muted-foreground" title={t('reach.mailboxes.warmup.none')}>
        —
      </span>
    );
  }

  const state = warmupStateToShow(mailbox);
  const figures = warmupFigures(mailbox);
  const placement = figures.inboxRate === null ? null : format.percent(figures.inboxRate);
  const placementHint = t(
    placement === null ? 'reach.mailboxes.warmup.inboxPlacementNoData' : 'reach.mailboxes.warmup.inboxPlacementHint',
    warmupCopyParams(),
  );

  return (
    <div className="min-w-44 space-y-1.5">
      <WarmupProgress mailbox={mailbox} />
      {state && <p className="text-xs font-medium">{t(`reach.mailboxes.warmup.states.${state}`)}</p>}
      <dl className="space-y-0.5 text-xs">
        <div className="flex items-baseline justify-between gap-3" title={placementHint}>
          <dt className="text-muted-foreground">{t('reach.mailboxes.warmup.inboxPlacement')}</dt>
          <dd className="font-medium tabular-nums">{placement ?? '—'}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">{t('reach.mailboxes.warmup.sent7d')}</dt>
          <dd className="font-medium tabular-nums">{format.number(figures.sent7d)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">{t('reach.mailboxes.warmup.spamRescues7d')}</dt>
          <dd className="font-medium tabular-nums">{format.number(figures.spamRescues7d)}</dd>
        </div>
      </dl>
      {figures.blocker && <WarmupBlockerNote blocker={figures.blocker} />}
    </div>
  );
}
