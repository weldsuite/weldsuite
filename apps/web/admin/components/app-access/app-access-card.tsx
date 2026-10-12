'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import {
  approveAppAccess,
  rejectAppAccess,
  revokeAppAccess,
  suspendAppAccess,
  unsuspendAppAccess,
  updateAppAccessLimits,
  updateAppAccessNotes,
  type AppAccessActionData,
} from '@/actions/app-access';
import type { ActionResult } from '@/actions/workspaces';
import {
  WELDREACH_APP_CODE,
  availableActions,
  formatAgainstLimit,
  formatCount,
  formatRate,
  limitsToFormValues,
  rate,
  type AccessAction,
  type LimitsFormValues,
  type ReachUsage,
} from '@/lib/app-access';
import type { AppAccessDetail } from '@/lib/app-access-data';
import { formatDateTime } from '@/lib/billing-format';
import { RequestAnswers } from './request-answers';
import { AccessStatusBadge } from './status-badge';

/** One workspace's access to one on-request app: the request, the limits, the usage, and the decisions. */
export function AppAccessCard({
  workspaceId,
  appCode,
  appName,
  access,
  usage,
  canWrite,
}: Readonly<{
  workspaceId: string;
  appCode: string;
  appName: string;
  /** Null when the workspace never asked (staff can still grant it). */
  access: AppAccessDetail | null;
  /** Only for WeldReach, and only when there is something to count. */
  usage?: ReachUsage;
  canWrite: boolean;
}>) {
  const status = access?.status ?? 'none';
  const actions = availableActions(status);
  const [dialog, setDialog] = useState<AccessAction | null>(null);

  return (
    <Card className="py-4">
      <CardContent className="space-y-5 px-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{appName} access</h2>
            <AccessStatusBadge status={status} />
          </div>
          {canWrite && actions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {actions.map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'approve' || action === 'unsuspend' ? 'default' : 'outline'}
                  className={
                    action === 'reject' || action === 'revoke'
                      ? 'border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive'
                      : undefined
                  }
                  onClick={() => setDialog(action)}
                >
                  {ACTION_LABEL[action]}
                </Button>
              ))}
            </div>
          )}
        </div>

        {access ? (
          <StatusLines access={access} />
        ) : (
          <p className="text-sm text-muted-foreground">
            This workspace has not asked for access to {appName}. You can still grant it.
          </p>
        )}

        {access?.request && (
          <Section title="Request">
            <RequestAnswers request={access.request} requestedByEmail={access.requestedByEmail} />
          </Section>
        )}

        {access && appCode === WELDREACH_APP_CODE && (
          <Section title="Limits and usage">
            <UsageGrid access={access} usage={usage} />
            <LimitsForm workspaceId={workspaceId} appCode={appCode} access={access} canWrite={canWrite} />
          </Section>
        )}

        {access && <BillingLine access={access} />}

        {access && <NotesForm workspaceId={workspaceId} appCode={appCode} access={access} canWrite={canWrite} />}

        {access && (
          <p className="text-xs text-muted-foreground">
            The module caches a workspace&apos;s access for up to a minute, so a change can take that long to reach
            requests already in flight. Sending itself checks again on every batch.
          </p>
        )}
      </CardContent>

      {dialog && (
        <StatusDialog
          action={dialog}
          workspaceId={workspaceId}
          appCode={appCode}
          appName={appName}
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}

const ACTION_LABEL: Record<AccessAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  suspend: 'Suspend',
  unsuspend: 'Unsuspend',
  revoke: 'Revoke',
};

const ACTION_COPY: Record<
  AccessAction,
  {
    title: (app: string) => string;
    description: string;
    submit: string;
    success: string;
    destructive?: boolean;
    run: (workspaceId: string, appCode: string, reason: string) => Promise<ActionResult<AppAccessActionData>>;
  }
> = {
  approve: {
    title: (app) => `Approve ${app}`,
    description:
      'The workspace can then use the app: it is installed for them, they get an email, and the limits below apply. The note is kept in the activity log.',
    submit: 'Approve',
    success: 'Access approved',
    run: approveAppAccess,
  },
  reject: {
    title: (app) => `Reject ${app}`,
    description:
      'The reason is shown to the workspace and emailed to the requester. They can file a new request afterwards.',
    submit: 'Reject',
    success: 'Request rejected',
    destructive: true,
    run: rejectAppAccess,
  },
  suspend: {
    title: (app) => `Suspend ${app}`,
    description:
      'Sending stops within a minute and the workspace sees the reason. Campaigns and mailboxes stay as they are, and you can unsuspend at any time.',
    submit: 'Suspend',
    success: 'Access suspended',
    destructive: true,
    run: suspendAppAccess,
  },
  unsuspend: {
    title: (app) => `Unsuspend ${app}`,
    description: 'Access goes back to approved and sending can resume. The note is kept in the activity log.',
    submit: 'Unsuspend',
    success: 'Access restored',
    run: unsuspendAppAccess,
  },
  revoke: {
    title: (app) => `Revoke ${app}`,
    description:
      'Takes the workspace back to having no access. It can file a new request, or you can approve it again. The reason is kept in the activity log only.',
    submit: 'Revoke',
    success: 'Access revoked',
    destructive: true,
    run: revokeAppAccess,
  },
};

function StatusDialog({
  action,
  workspaceId,
  appCode,
  appName,
  onClose,
}: Readonly<{
  action: AccessAction;
  workspaceId: string;
  appCode: string;
  appName: string;
  onClose: () => void;
}>) {
  const router = useRouter();
  const copy = ACTION_COPY[action];
  return (
    <ActionDialog
      title={copy.title(appName)}
      description={copy.description}
      submitLabel={copy.submit}
      destructive={copy.destructive}
      onClose={onClose}
      onSubmit={async (reason) => {
        const result = await copy.run(workspaceId, appCode, reason);
        if (result.ok) router.refresh();
        return result;
      }}
      successMessage={copy.success}
    />
  );
}

function Section({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function StatusLines({ access }: Readonly<{ access: AppAccessDetail }>) {
  const lines: string[] = [];
  if (access.requestedAt) {
    const by = access.requestedByEmail ? ` by ${access.requestedByEmail}` : '';
    lines.push(`Requested ${formatDateTime(access.requestedAt)}${by}`);
  }
  if (access.reviewedAt) {
    const by = access.reviewedBy ? ` by ${access.reviewedBy}` : '';
    lines.push(`Last decision ${formatDateTime(access.reviewedAt)}${by}`);
  }
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {access.status === 'rejected' && access.rejectionReason && (
        <p className="text-foreground">
          Reason shown to the workspace: <span className="italic">“{access.rejectionReason}”</span>
        </p>
      )}
      {access.status === 'suspended' && access.suspendedReason && (
        <p className="text-foreground">
          Reason shown to the workspace: <span className="italic">“{access.suspendedReason}”</span>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage against the limits
// ---------------------------------------------------------------------------

function UsageGrid({ access, usage }: Readonly<{ access: AppAccessDetail; usage?: ReachUsage }>) {
  const limits = access.limits;
  const u = usage;
  const bounceRate = rate(u?.bounced7d ?? null, u?.sent7d ?? null);
  const replyRate = rate(u?.replies7d ?? null, u?.sent7d ?? null);
  const over = (used: number | null | undefined, limit: number) => used !== null && used !== undefined && used > limit;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <Stat label="Domains" value={formatAgainstLimit(u?.domains ?? null, limits.maxDomains)} warn={over(u?.domains, limits.maxDomains)} />
      <Stat
        label="Mailboxes"
        value={formatAgainstLimit(u?.mailboxes ?? null, limits.maxMailboxes)}
        warn={over(u?.mailboxes, limits.maxMailboxes)}
      />
      <Stat
        label="Sent, last 24 h"
        value={formatAgainstLimit(u?.sent24h ?? null, limits.maxDailySends)}
        warn={over(u?.sent24h, limits.maxDailySends)}
      />
      <Stat label="Sent, last 7 days" value={formatCount(u?.sent7d ?? null)} />
      <Stat label="Bounce rate, 7 days" value={formatRate(bounceRate)} warn={bounceRate !== null && bounceRate > 0.05} />
      <Stat label="Reply rate, 7 days" value={formatRate(replyRate)} />
    </div>
  );
}

function Stat({ label, value, warn }: Readonly<{ label: string; value: string; warn?: boolean }>) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${warn ? 'text-destructive' : ''}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function LimitsForm({
  workspaceId,
  appCode,
  access,
  canWrite,
}: Readonly<{ workspaceId: string; appCode: string; access: AppAccessDetail; canWrite: boolean }>) {
  const router = useRouter();
  const saved = limitsToFormValues(access.limits);
  const [values, setValues] = useState<LimitsFormValues>(saved);
  const [isPending, startTransition] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const set = <K extends keyof LimitsFormValues>(key: K, value: LimitsFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));
  const idBase = `limits-${access.id}`;

  const save = () =>
    startTransition(async () => {
      const result = await updateAppAccessLimits(workspaceId, appCode, values);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Limits saved');
      // Show what was stored (domains are lowercased and de-duplicated on save).
      setValues(limitsToFormValues(result.data.access.limits));
      router.refresh();
    });

  return (
    <div className="space-y-3">
      {access.limitsUnset && (
        <p className="text-xs text-muted-foreground">No limits are stored yet; the defaults are shown and apply.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Max domains" htmlFor={`${idBase}-domains`}>
          <Input
            id={`${idBase}-domains`}
            inputMode="numeric"
            value={values.maxDomains}
            disabled={!canWrite}
            onChange={(e) => set('maxDomains', e.target.value)}
          />
        </Field>
        <Field label="Max mailboxes" htmlFor={`${idBase}-mailboxes`}>
          <Input
            id={`${idBase}-mailboxes`}
            inputMode="numeric"
            value={values.maxMailboxes}
            disabled={!canWrite}
            onChange={(e) => set('maxMailboxes', e.target.value)}
          />
        </Field>
        <Field label="Max sends per day" htmlFor={`${idBase}-sends`}>
          <Input
            id={`${idBase}-sends`}
            inputMode="numeric"
            value={values.maxDailySends}
            disabled={!canWrite}
            onChange={(e) => set('maxDailySends', e.target.value)}
          />
        </Field>
      </div>

      <Label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal">
        <Checkbox
          checked={values.allowConsumerRecipients}
          disabled={!canWrite}
          onCheckedChange={(v) => set('allowConsumerRecipients', v === true)}
          className="mt-0.5"
        />
        <div>
          <div className="text-sm font-medium">Allow free-mail recipients</div>
          <div className="text-xs text-muted-foreground">
            gmail.com, outlook.com and the like. Off keeps the workspace to business addresses.
          </div>
        </div>
      </Label>

      <Field
        label="Domains allowed despite existing mail or a website"
        htmlFor={`${idBase}-force`}
        hint="One per line. These can be connected even though they have MX records or a website; Mailpool then replaces their mail records."
      >
        <Textarea
          id={`${idBase}-force`}
          value={values.forceAllowDomains}
          disabled={!canWrite}
          onChange={(e) => set('forceAllowDomains', e.target.value)}
          rows={3}
          className="font-mono text-xs"
          placeholder="getacme.com"
        />
      </Field>

      {canWrite && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={isPending || (!dirty && !access.limitsUnset)} onClick={save}>
            {isPending ? 'Saving…' : 'Save limits'}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" disabled={isPending} onClick={() => setValues(saved)}>
              Reset
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Billing and notes
// ---------------------------------------------------------------------------

const BILLING_LABEL: Record<AppAccessDetail['billingStatus'], string> = {
  none: 'No subscription',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
};

function BillingLine({ access }: Readonly<{ access: AppAccessDetail }>) {
  return (
    <Section title="Billing">
      <p className="text-sm">
        <span className={access.billingStatus === 'past_due' ? 'text-destructive' : undefined}>
          {BILLING_LABEL[access.billingStatus]}
        </span>
        {access.billingStatusAt && (
          <span className="text-muted-foreground"> since {formatDateTime(access.billingStatusAt)}</span>
        )}
        {access.hasSubscription && <span className="text-muted-foreground"> · Stripe subscription linked</span>}
      </p>
      <p className="text-xs text-muted-foreground">
        Written by the billing worker from the inbox subscription; read-only here.
      </p>
    </Section>
  );
}

function NotesForm({
  workspaceId,
  appCode,
  access,
  canWrite,
}: Readonly<{ workspaceId: string; appCode: string; access: AppAccessDetail; canWrite: boolean }>) {
  const router = useRouter();
  const [notes, setNotes] = useState(access.reviewNotes ?? '');
  const [isPending, startTransition] = useTransition();
  const dirty = notes.trim() !== (access.reviewNotes ?? '').trim();

  const save = () =>
    startTransition(async () => {
      const result = await updateAppAccessNotes(workspaceId, appCode, notes);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Notes saved');
      router.refresh();
    });

  return (
    <Section title="Internal notes">
      <Textarea
        value={notes}
        disabled={!canWrite}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Only staff see these."
        aria-label="Internal notes"
      />
      {canWrite && (
        <Button size="sm" variant="outline" disabled={isPending || !dirty} onClick={save}>
          {isPending ? 'Saving…' : 'Save notes'}
        </Button>
      )}
    </Section>
  );
}
