'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { updateOutboundPolicy } from '@/actions/outbound-mail';
import {
  LIMIT_FIELDS,
  LIMIT_KEYS,
  OUTBOUND_STATES,
  OUTBOUND_TRUST_LEVELS,
  STATE_HINTS,
  STATE_LABELS,
  TRUST_LABELS,
  isOutboundState,
  isTrustLevel,
  limitDefault,
  limitOverridesToForm,
  parseLimitOverridesForm,
  planPolicyUpdate,
  type LimitKey,
  type LimitOverrideFormValues,
  type OutboundPolicyUpdate,
  type OutboundState,
  type OutboundTrustLevel,
  type PolicyField,
  type PolicySnapshot,
} from '@/lib/outbound-mail';

type TrustChoice = OutboundTrustLevel | 'computed';

interface FormValues {
  trust: TrustChoice;
  state: OutboundState;
  stateReason: string;
  allowReplies: boolean;
  limits: LimitOverrideFormValues;
  notes: string;
}

function toForm(policy: PolicySnapshot): FormValues {
  return {
    trust: policy.trustOverride ?? 'computed',
    state: policy.state,
    stateReason: policy.stateReason ?? '',
    allowReplies: policy.allowRepliesWhenSuspended,
    limits: limitOverridesToForm(policy.limits),
    notes: policy.notes ?? '',
  };
}

const FIELD_LABELS: Record<PolicyField, string> = {
  trustOverride: 'trust level',
  limits: 'limits',
  state: 'state',
  stateReason: 'reason shown to the customer',
  allowRepliesWhenSuspended: 'replies while suspended',
  notes: 'staff notes',
};

/**
 * The staff-editable sending policy of one workspace. Saving asks for a reason
 * (kept in the trail and the activity log) and then makes mail-api reload the
 * policy, so the change applies to the next send. Mount it with a key that
 * changes when the stored policy does, so a save starts it fresh.
 */
export function PolicyForm({
  workspaceId,
  policy,
  computedTrust,
  canWrite,
}: Readonly<{
  workspaceId: string;
  /** The stored policy, or the defaults when the workspace has no row. */
  policy: PolicySnapshot;
  /** The level the guard computes without an override (live when available). */
  computedTrust: OutboundTrustLevel;
  canWrite: boolean;
}>) {
  const router = useRouter();
  const saved = useMemo(() => toForm(policy), [policy]);
  const [values, setValues] = useState<FormValues>(saved);
  const [confirming, setConfirming] = useState(false);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((prev) => ({ ...prev, [key]: value }));
  const setLimit = (key: LimitKey, value: string) =>
    setValues((prev) => ({ ...prev, limits: { ...prev.limits, [key]: value } }));

  const effectiveTrust = values.trust === 'computed' ? computedTrust : values.trust;
  const limits = parseLimitOverridesForm(values.limits);

  const update: OutboundPolicyUpdate | null = limits.ok
    ? {
        trustOverride: values.trust === 'computed' ? null : values.trust,
        limits: limits.limits,
        state: values.state,
        stateReason: values.stateReason,
        allowRepliesWhenSuspended: values.allowReplies,
        notes: values.notes,
      }
    : null;
  const plan = update ? planPolicyUpdate(policy, update) : null;
  let error: string | null = null;
  if (!limits.ok) error = limits.error;
  else if (plan && !plan.ok) error = plan.error;
  const changed = plan?.ok ? plan.changed : [];
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  return (
    <Card className="py-4">
      <CardContent className="space-y-5 px-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Trust level"
            htmlFor="outbound-trust"
            hint={
              values.trust === 'computed'
                ? `From age, plan and record. Now ${TRUST_LABELS[computedTrust].toLowerCase()}.`
                : 'Pinned by staff until set back to computed.'
            }
          >
            <Select
              value={values.trust}
              disabled={!canWrite}
              onValueChange={(v) => set('trust', isTrustLevel(v) ? v : 'computed')}
            >
              <SelectTrigger id="outbound-trust" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="computed">Computed ({TRUST_LABELS[computedTrust].toLowerCase()})</SelectItem>
                {OUTBOUND_TRUST_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {TRUST_LABELS[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="State" htmlFor="outbound-state" hint={STATE_HINTS[values.state]}>
            <Select
              value={values.state}
              disabled={!canWrite}
              onValueChange={(v) => {
                if (isOutboundState(v)) set('state', v);
              }}
            >
              <SelectTrigger id="outbound-state" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OUTBOUND_STATES.map((state) => (
                  <SelectItem key={state} value={state}>
                    {STATE_LABELS[state]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {values.state !== 'active' && (
          <Field
            label="Reason shown to the customer"
            htmlFor="outbound-state-reason"
            hint="Shown in WeldMail while the restriction is on. Plain words, no internal detail."
          >
            <Textarea
              id="outbound-state-reason"
              value={values.stateReason}
              disabled={!canWrite}
              onChange={(e) => set('stateReason', e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="We paused new conversations from this workspace while we review its sending. Replies still go out."
            />
          </Field>
        )}

        <Label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal">
          <Checkbox
            checked={values.allowReplies}
            disabled={!canWrite}
            onCheckedChange={(v) => set('allowReplies', v === true)}
            className="mt-0.5"
          />
          <div>
            <div className="text-sm font-medium">Allow replies while suspended</div>
            <div className="text-xs text-muted-foreground">
              Replies to people who wrote to the workspace still go out. Only matters while suspended.
            </div>
          </div>
        </Label>

        <section className="space-y-3 border-t pt-4">
          <div className="space-y-1">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Limit overrides</h3>
            <p className="text-xs text-muted-foreground">
              In recipients. Blank uses the default for {TRUST_LABELS[effectiveTrust].toLowerCase()} (shown greyed).
              {values.state === 'restricted' && ' While restricted, the restricted limits apply and these overrides are ignored.'}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LIMIT_KEYS.map((key) => (
              <Field key={key} label={LIMIT_FIELDS[key].label} htmlFor={`outbound-limit-${key}`} hint={LIMIT_FIELDS[key].hint}>
                <Input
                  id={`outbound-limit-${key}`}
                  inputMode="numeric"
                  value={values.limits[key]}
                  disabled={!canWrite}
                  onChange={(e) => setLimit(key, e.target.value)}
                  placeholder={limitDefault(key, effectiveTrust, values.state)}
                />
              </Field>
            ))}
          </div>
        </section>

        <section className="space-y-2 border-t pt-4">
          <Field label="Staff notes" htmlFor="outbound-notes" hint="Only staff see these.">
            <Textarea
              id="outbound-notes"
              value={values.notes}
              disabled={!canWrite}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              maxLength={5000}
            />
          </Field>
        </section>

        {dirty && error && <p className="text-xs text-destructive">{error}</p>}

        {canWrite && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!dirty || !!error || changed.length === 0} onClick={() => setConfirming(true)}>
              Save changes
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => setValues(saved)}>
                Reset
              </Button>
            )}
          </div>
        )}
      </CardContent>

      {confirming && update && (
        <ActionDialog
          title="Save the sending policy"
          description={`You are changing the ${changed.map((field) => FIELD_LABELS[field]).join(', ')}. Sending picks it up on the next message. The reason goes to the trail and the activity log, not to the customer.`}
          submitLabel="Save policy"
          destructive={values.state === 'suspended' && policy.state !== 'suspended'}
          onClose={() => setConfirming(false)}
          onSubmit={async (reason) => {
            const result = await updateOutboundPolicy(workspaceId, update, reason);
            if (result.ok) router.refresh();
            return result;
          }}
          successMessage="Policy saved"
        />
      )}
    </Card>
  );
}
