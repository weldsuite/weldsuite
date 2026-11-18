import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SettingRow } from '@weldsuite/ui/components/settings-layout';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  SSO_DEFAULT_ROLES,
  type SsoConfigView,
  type SsoDefaultRole,
  type SsoOidcView,
} from '@weldsuite/app-api-client/schemas/sso';
import { useI18n } from '@/lib/i18n/provider';
import { useActivateSso, useDeactivateSso, useSaveSsoOidcConnection } from '@/hooks/queries/use-sso-queries';
import { ssoErrorMessage } from './sso-errors';
import { InlineError, StepCard } from './sso-parts';
import { oidcActivationBlock, verifiedDomainNames } from './sso-view';

type Confirm = 'enable' | 'enforce' | null;

interface SsoOidcSignInStepProps {
  config: SsoConfigView;
  oidc: SsoOidcView;
  canManage: boolean;
}

/**
 * WeldID mode, step 3: switch single sign-on on, require it for the
 * verified domains, and pick the role new people join with. Switching on
 * and requiring it ask first; switching either off never waits.
 */
export function SsoOidcSignInStep({ config, oidc, canManage }: Readonly<SsoOidcSignInStepProps>) {
  const { t, format } = useI18n();
  const ts = t.settings.sso;
  const copy = ts.weldid.signIn;
  const connection = oidc.connection;

  const activate = useActivateSso();
  const deactivate = useDeactivateSso();
  const save = useSaveSsoOidcConnection();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<unknown>(null);

  const enabled = connection?.enabled ?? false;
  const enforced = connection?.enforceSso ?? false;
  const block = oidcActivationBlock(config, oidc);
  // Switching off must stay possible whatever else is missing.
  const enableBlocked = !enabled && block !== null;
  const domains = verifiedDomainNames(oidc);
  const busy = activate.isPending || deactivate.isPending;

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null);
    try {
      await action();
      toast.success(success);
    } catch (err) {
      setError(err);
    } finally {
      setConfirm(null);
    }
  };

  const onEnabledChange = (next: boolean) => {
    if (next) setConfirm('enable');
    else void run(() => deactivate.mutateAsync(), copy.switchedOff);
  };

  const onEnforceChange = (next: boolean) => {
    if (next) setConfirm('enforce');
    else void run(() => save.mutateAsync({ enforceSso: false }), copy.enforcedOff);
  };

  const onRoleChange = (role: string) => {
    void run(() => save.mutateAsync({ defaultRole: role as SsoDefaultRole }), copy.roleSaved);
  };

  return (
    <StepCard
      step={3}
      title={copy.title}
      description={copy.description}
      done={oidc.active}
      badge={oidc.active ? <Badge variant="success">{ts.status.active}</Badge> : undefined}
    >
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            <Label htmlFor="sso-oidc-enabled" className="text-sm font-medium">{copy.enabled}</Label>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          </span>
        }
        description={enableBlocked && block ? copy.blocked[block] : copy.enabledDescription}
      >
        <Switch
          id="sso-oidc-enabled"
          checked={enabled}
          disabled={!canManage || busy || enableBlocked}
          onCheckedChange={onEnabledChange}
        />
      </SettingRow>

      <SettingRow
        label={<Label htmlFor="sso-oidc-enforce" className="text-sm font-medium">{copy.enforce}</Label>}
        description={copy.enforceDescription}
      >
        <Switch
          id="sso-oidc-enforce"
          checked={enforced}
          disabled={!canManage || !connection || save.isPending}
          onCheckedChange={onEnforceChange}
        />
      </SettingRow>
      {(enforced || confirm === 'enforce') && <InfoBanner variant="warning">{copy.enforceWarning}</InfoBanner>}

      <SettingRow
        label={<Label htmlFor="sso-oidc-role" className="text-sm font-medium">{copy.defaultRole}</Label>}
        description={copy.defaultRoleDescription}
      >
        <Select value={oidc.defaultRole} onValueChange={onRoleChange} disabled={!canManage || save.isPending}>
          <SelectTrigger id="sso-oidc-role" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SSO_DEFAULT_ROLES.map((role) => (
              <SelectItem key={role} value={role}>
                {copy.roles[role]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {error !== null && <InlineError>{ssoErrorMessage(error, ts.errors, true)}</InlineError>}

      <ConfirmDialog
        open={confirm === 'enable'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={copy.confirmOnTitle}
        description={format(copy.confirmOnDescription, { domains })}
        confirmLabel={copy.confirmOn}
        cancelLabel={t.common.actions.cancel}
        onConfirm={() => run(() => activate.mutateAsync(), copy.switchedOn)}
      />
      <ConfirmDialog
        open={confirm === 'enforce'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={copy.confirmEnforceTitle}
        description={
          <>
            <span className="block">{copy.enforceDescription}</span>
            <span className="mt-2 block font-medium">{copy.enforceWarning}</span>
          </>
        }
        confirmLabel={copy.confirmEnforce}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={() => run(() => save.mutateAsync({ enforceSso: true }), copy.enforcedOn)}
      />
    </StepCard>
  );
}
