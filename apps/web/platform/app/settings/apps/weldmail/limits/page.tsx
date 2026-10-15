import type { ReactNode } from 'react';
import { Gauge } from 'lucide-react';
import type {
  OutboundState,
  OutboundUsage,
  OutboundUsageWindow,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Progress } from '@weldsuite/ui/components/progress';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PageLoader } from '@/components/page-loader';
import { useMailSendingUsage } from '@/hooks/queries/use-mail-sending-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { meterPercent, meterTone, type MeterTone } from './usage-meter';

const HELP_URL = 'https://help.weldsuite.org/weldmail/sending-limits';

const STATE_BADGE: Record<OutboundState, 'success' | 'warning' | 'destructive'> = {
  active: 'success',
  restricted: 'warning',
  hold: 'warning',
  suspended: 'destructive',
};

const TONE_CLASS: Record<MeterTone, string> = {
  ok: '',
  warning: '[&_[data-slot=progress-indicator]]:bg-amber-500',
  full: '[&_[data-slot=progress-indicator]]:bg-red-500',
};

interface Labels {
  usedOf: string;
  usedOnly: string;
}

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.replaceAll(`{${key}}`, value);
  return out;
}

/** One window: a label, "used of limit" and a bar that fills up. */
function Meter({
  label,
  hint,
  window,
  format,
  labels,
}: Readonly<{
  label: string;
  hint?: string;
  /** `limit: null` means no cap: only the count is shown. */
  window: { used: number; limit: number | null };
  format: (n: number) => string;
  labels: Labels;
}>) {
  const { used, limit } = window;
  const text =
    limit === null
      ? fill(labels.usedOnly, { used: format(used) })
      : fill(labels.usedOf, { used: format(used), limit: format(limit) });
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{text}</span>
      </div>
      {limit === null ? null : (
        <Progress
          value={meterPercent(used, limit)}
          aria-label={`${label}: ${text}`}
          className={cn('h-1.5', TONE_CLASS[meterTone(used, limit)])}
        />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Fact({ label, children, hint }: Readonly<{ label: string; children: ReactNode; hint: string }>) {
  return (
    <Card>
      <CardContent className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="text-lg font-semibold">{children}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function Delivery({ label, value, hint }: Readonly<{ label: string; value: string; hint?: string }>) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function asWindow(w: OutboundUsageWindow): { used: number; limit: number } {
  return { used: w.used, limit: w.limit };
}

export default function MailSendingLimitsSettingsPage() {
  const { t, language } = useI18n();
  const tl = t.settings.weldmail.limits;
  const { data: usage, isLoading } = useMailSendingUsage();
  const number = new Intl.NumberFormat(language);
  const format = (n: number) => number.format(n);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!usage) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <EmptyStateIllustration>
          <Gauge className="h-16 w-16 text-muted-foreground/50" />
        </EmptyStateIllustration>
        <h3 className="mb-1 text-lg font-medium">{tl.unavailableTitle}</h3>
        <p className="max-w-md text-center text-sm text-muted-foreground">{tl.unavailableDescription}</p>
      </div>
    );
  }

  return <LimitsContent usage={usage} format={format} />;
}

function LimitsContent({ usage, format }: Readonly<{ usage: OutboundUsage; format: (n: number) => string }>) {
  const { t } = useI18n();
  const tl = t.settings.weldmail.limits;
  const labels: Labels = { usedOf: tl.usedOf, usedOnly: tl.usedOnly };
  const { workspace, deliveries7d } = usage;
  const reason = usage.stateReason?.trim();

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-muted-foreground">
        {tl.description}{' '}
        <a
          href={HELP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          {tl.learnMore}
        </a>
      </p>

      {usage.mode === 'shadow' ? (
        <Alert>
          <AlertDescription>{tl.shadowNote}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Fact label={tl.trustLevel} hint={tl.trustHint[usage.trustLevel]}>
          {tl.trust[usage.trustLevel]}
        </Fact>
        <Fact label={tl.status} hint={reason || tl.stateHint[usage.state]}>
          <Badge variant={STATE_BADGE[usage.state]}>{tl.state[usage.state]}</Badge>
        </Fact>
      </div>

      {usage.coldOutreachCapped ? (
        <Alert>
          <AlertTitle>{tl.coldCappedTitle}</AlertTitle>
          <AlertDescription>
            <p>{tl.coldCappedDescription}</p>
            <Link
              href="/appstore/weldreach"
              className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
            >
              {tl.requestWeldReach}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{tl.usageTitle}</CardTitle>
          <CardDescription>
            {tl.usageDescription}{' '}
            {fill(tl.perMessageLimit, { limit: format(usage.limits.recipientsPerMessage) })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Meter
            label={tl.workspaceRecipients}
            hint={fill(tl.workspaceRecipientsHint, { count: format(workspace.hour) })}
            window={asWindow(workspace.day)}
            format={format}
            labels={labels}
          />
          <Meter
            label={tl.newContacts}
            hint={tl.newContactsHint}
            window={asWindow(workspace.firstContactDay)}
            format={format}
            labels={labels}
          />
          <Meter
            label={tl.thisMonth}
            hint={workspace.month.limit === null ? tl.noMonthlyCap : undefined}
            window={workspace.month}
            format={format}
            labels={labels}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tl.perAddressTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.senders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tl.noAddresses}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {usage.senders.map((sender) => (
                <li key={sender.email} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1.2fr)_1fr_1fr] sm:items-center">
                  <span className="truncate text-sm font-medium" title={sender.email}>
                    {sender.email}
                  </span>
                  <Meter label={tl.perHour} window={asWindow(sender.hour)} format={format} labels={labels} />
                  <Meter label={tl.perDay} window={asWindow(sender.day)} format={format} labels={labels} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tl.deliveriesTitle}</CardTitle>
          <CardDescription>{tl.deliveriesNote}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Delivery label={tl.delivered} value={format(deliveries7d.delivered)} />
            <Delivery label={tl.hardBounces} value={format(deliveries7d.hardBounces)} hint={tl.hardBouncesHint} />
            <Delivery label={tl.softBounces} value={format(deliveries7d.softBounces)} hint={tl.softBouncesHint} />
            <Delivery label={tl.complaints} value={format(deliveries7d.complaints)} hint={tl.complaintsHint} />
            <Delivery label={tl.rejected} value={format(deliveries7d.rejected)} hint={tl.rejectedHint} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
