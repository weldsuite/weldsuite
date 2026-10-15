import { TriangleAlert } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Stat } from '@/components/warmup/parts';
import { formatDateTime } from '@/lib/billing-format';
import type { LiveState } from '@/lib/mail-api';
import { formatAgainstQuota, quotaShare, type PlatformStatus } from '@/lib/outbound-mail';
import type { OutboundEventRow } from '@/lib/outbound-mail-data';

/** Why a live panel is empty: mail-api is not wired up, or it did not answer. */
export function LiveUnavailable({ state }: Readonly<{ state: Exclude<LiveState<unknown>, { kind: 'ok' }> }>) {
  return (
    <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
      {state.kind === 'not_configured'
        ? 'Live data unavailable: this console is not connected to mail-api (MAIL_API_URL, OUTBOUND_ADMIN_SECRET). Everything else here comes from the database.'
        : `Live data unavailable: ${state.message}`}
    </p>
  );
}

/**
 * The platform breaker: customer mail shares one Cloudflare account, and at 70%
 * of its daily quota first-contact mail from new and standard workspaces stops
 * until midnight UTC.
 */
export function PlatformStatusCard({
  state,
  events,
}: Readonly<{ state: LiveState<PlatformStatus>; events: OutboundEventRow[] }>) {
  const last = events[0];
  return (
    <div className="space-y-3">
      {state.kind === 'ok' ? (
        <>
          {state.data.tripped && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p>
                <strong>The platform breaker is tripped.</strong> First-contact mail from new and standard workspaces is
                stopped until midnight UTC.{state.data.reason ? ` ${state.data.reason}` : ''}
              </p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              label="Platform breaker"
              value={state.data.tripped ? 'Tripped' : 'Not tripped'}
              tone={state.data.tripped ? 'warning' : 'default'}
              hint={state.data.reason ?? 'Trips at 70% of the daily quota'}
            />
            <Stat
              label="Recipients today (UTC)"
              value={state.data.recipients.toLocaleString('en-GB')}
              tone={(quotaShare(state.data.recipients, state.data.quota) ?? 0) >= 0.7 ? 'warning' : 'default'}
              hint={state.data.quota === null ? 'No quota configured' : formatAgainstQuota(state.data.recipients, state.data.quota)}
            />
            <Stat
              label="Daily quota"
              value={state.data.quota === null ? '—' : state.data.quota.toLocaleString('en-GB')}
              hint="Cloudflare account, all customer mail"
            />
          </div>
        </>
      ) : (
        <LiveUnavailable state={state} />
      )}
      {last && (
        <Card className="py-3">
          <CardContent className="px-4 text-xs text-muted-foreground">
            Last tripped {formatDateTime(last.createdAt)}
            {last.reason ? `: ${last.reason}` : ''}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
