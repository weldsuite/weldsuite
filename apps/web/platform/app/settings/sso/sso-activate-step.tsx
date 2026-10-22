import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import type { SsoConfigView } from '@weldsuite/app-api-client/schemas/sso';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useActivateSso, useDeactivateSso } from '@/hooks/queries/use-sso-queries';
import { ssoErrorMessage } from './sso-errors';
import { InlineError, Notice, StepCard } from './sso-parts';
import { activationBlock, isPaused } from './sso-view';

interface SsoActivateStepProps {
  config: SsoConfigView;
  canManage: boolean;
}

/**
 * Step 3: switch single sign-on on or off. Switching on locks everyone at the
 * domain into the identity provider, so it asks first; switching off never waits.
 */
export function SsoActivateStep({ config, canManage }: Readonly<SsoActivateStepProps>) {
  const { t, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.activate;

  const connection = config.connection;
  const enabled = connection?.enabled ?? false;
  const domain = config.domain?.name ?? '';
  const block = activationBlock(config);
  // Switching off must stay possible whatever else is missing.
  const blockedReason = !enabled && block ? copy.blocked[block] : null;

  // Switched on but paused (the add-on ended) says nothing here: the notice below does.
  const statusLine = enabled
    ? connection?.active
      ? format(copy.statusOn, { domain })
      : null
    : (blockedReason ?? copy.statusOff);

  const activate = useActivateSso();
  const deactivate = useDeactivateSso();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = activate.isPending || deactivate.isPending;

  const switchOn = async () => {
    setError(null);
    try {
      await activate.mutateAsync();
      toast.success(copy.switchedOn);
    } catch (err) {
      setError(err);
    } finally {
      setConfirmOpen(false);
    }
  };

  const switchOff = async () => {
    setError(null);
    try {
      await deactivate.mutateAsync();
      toast.success(copy.switchedOff);
    } catch (err) {
      setError(err);
    }
  };

  const onCheckedChange = (next: boolean) => {
    if (next) setConfirmOpen(true);
    else void switchOff();
  };

  return (
    <StepCard
      step={3}
      title={copy.title}
      description={format(copy.description, { domain })}
      done={Boolean(connection?.active)}
      badge={connection?.active ? <Badge variant="success">{ts.status.active}</Badge> : undefined}
    >
      <div className="flex items-start gap-3">
        <Switch
          id="sso-activate"
          checked={enabled}
          disabled={!canManage || pending || blockedReason !== null}
          onCheckedChange={onCheckedChange}
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor="sso-activate" className="inline-flex items-center gap-2 text-sm font-medium">
            {copy.label}
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </Label>
          {statusLine && <p className="text-sm text-muted-foreground">{statusLine}</p>}
          {enabled && <p className="text-sm text-muted-foreground">{copy.offHint}</p>}
        </div>
      </div>

      {connection && isPaused(config) && <Notice tone="warning">{copy.paused}</Notice>}
      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors)}</InlineError>}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.confirmTitle}
        description={
          <>
            <span className="block">{format(copy.confirmWarning, { domain })}</span>
            <span className="mt-2 block">{copy.confirmAdvice}</span>
          </>
        }
        confirmLabel={copy.confirm}
        cancelLabel={t.common.actions.cancel}
        onConfirm={switchOn}
      />
    </StepCard>
  );
}
