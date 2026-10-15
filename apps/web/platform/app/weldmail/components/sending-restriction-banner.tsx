import { AlertTriangle, Ban, PauseCircle } from 'lucide-react';
import type { OutboundState, OutboundUsage } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { useMailSendingUsage } from '@/hooks/queries/use-mail-sending-queries';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

type RestrictedState = Exclude<OutboundState, 'active'>;

const TONES: Record<RestrictedState, { icon: typeof AlertTriangle; className: string }> = {
  restricted: {
    icon: AlertTriangle,
    className:
      'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
  },
  hold: {
    icon: PauseCircle,
    className:
      'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
  },
  suspended: {
    icon: Ban,
    className:
      'border-red-200 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
  },
};

/**
 * Whether sending is restricted, on hold or suspended right now. In `shadow`
 * mode the guard decides and logs but never blocks, so nothing is restricted
 * as far as the customer can tell and there is nothing to announce.
 */
export function isSendingRestricted(usage: OutboundUsage | null | undefined): usage is OutboundUsage & {
  state: RestrictedState;
} {
  return usage != null && usage.mode === 'enforce' && usage.state !== 'active';
}

/**
 * Shown on top of WeldMail while the workspace is `restricted`, on `hold` or
 * `suspended` (outbound mail guard). Says what is going on, in the words staff
 * left for the customer when there are any, and that replies still go through
 * (not while suspended). Renders nothing when sending is normal or the guard
 * is not available.
 */
export function SendingRestrictionBanner() {
  const { t } = useI18n();
  const { data: usage } = useMailSendingUsage();
  if (!isSendingRestricted(usage)) return null;

  const b = t.mail.sending.banner;
  const copy: Record<RestrictedState, { title: string; body: string }> = {
    restricted: { title: b.restrictedTitle, body: b.restricted },
    hold: { title: b.holdTitle, body: b.hold },
    suspended: { title: b.suspendedTitle, body: b.suspended },
  };
  const { title, body } = copy[usage.state];
  const { icon: Icon, className } = TONES[usage.state];
  const reason = usage.stateReason?.trim();

  return (
    <div
      role="status"
      data-testid="mail-sending-restriction-banner"
      className={cn('flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1.5 border-b px-4 py-2.5 text-sm', className)}
    >
      {/* The link drops under the text on a phone instead of squeezing it. */}
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          {/* Staff's words may end without a full stop, so they get their own line. */}
          <p className="opacity-90">{reason || body}</p>
          <p className="opacity-90">
            {usage.state !== 'suspended' && `${b.repliesStillWork} `}
            {b.contactSupport}
          </p>
        </div>
      </div>
      <Link
        href="/settings/apps/weldmail?tab=limits"
        className="shrink-0 pl-7 font-medium underline underline-offset-2 hover:no-underline sm:pl-0"
      >
        {b.viewLimits}
      </Link>
    </div>
  );
}
