/** WeldHR workforce portal — master enable + capability toggles. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWorkspace } from '@/contexts/workspace-context';
import { useHrPortalSettings, useUpdateHrPortalSettings } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, InlineSpinner, errorMessage } from '../../components/shared';
import { hrPortalUrl } from './portal-url';

interface ToggleRowProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function ToggleRow({ id, label, hint, checked, disabled, onCheckedChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function PortalSettingsTab() {
  const t = useTranslations();
  const { currentWorkspace } = useWorkspace();
  const { data, isLoading, error } = useHrPortalSettings();
  const update = useUpdateHrPortalSettings();
  const [failure, setFailure] = useState<string | null>(null);

  async function save(patch: Record<string, unknown>) {
    setFailure(null);
    try {
      await update.mutateAsync(patch);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  if (isLoading) return <InlineSpinner />;
  if (error) return <ErrorBanner error={errorMessage(error, t('weldhr.common.loadFailed'))} />;
  if (!data) return null;

  const portalUrl = hrPortalUrl(data.customDomain, currentWorkspace?.slug);

  return (
    <div className="space-y-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <Card>
        <CardHeader>
          <CardTitle>{t('weldhr.portal.settings.enableTitle')}</CardTitle>
          <CardDescription>
            {data.isEnabled ? t('weldhr.portal.settings.enabledHint') : t('weldhr.portal.settings.disabledHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            id="portal-enabled"
            label={t('weldhr.portal.settings.enableTitle')}
            checked={data.isEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => save({ isEnabled: checked })}
          />

          <div className="space-y-1.5">
            <Label>{t('weldhr.portal.settings.portalUrl')}</Label>
            <div className="flex gap-2">
              <Input readOnly value={portalUrl ?? t('weldhr.portal.settings.portalUrlUnavailable')} />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!portalUrl}
                onClick={async () => {
                  if (!portalUrl) return;
                  await navigator.clipboard.writeText(portalUrl);
                  toast.success(t('weldhr.portal.settings.urlCopied'));
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('weldhr.portal.settings.accessTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ToggleRow
            id="employee-portal-enabled"
            label={t('weldhr.portal.settings.employeePortalEnabled')}
            checked={data.employeePortalEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => save({ employeePortalEnabled: checked })}
          />
          <ToggleRow
            id="client-portal-enabled"
            label={t('weldhr.portal.settings.clientPortalEnabled')}
            checked={data.clientPortalEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => save({ clientPortalEnabled: checked })}
          />
          <ToggleRow
            id="employee-self-clockin"
            label={t('weldhr.portal.settings.employeeSelfClockIn')}
            checked={data.employeeSelfClockIn}
            disabled={update.isPending}
            onCheckedChange={(checked) => save({ employeeSelfClockIn: checked })}
          />
          <ToggleRow
            id="employee-leave-requests"
            label={t('weldhr.portal.settings.employeeLeaveRequests')}
            checked={data.employeeLeaveRequests}
            disabled={update.isPending}
            onCheckedChange={(checked) => save({ employeeLeaveRequests: checked })}
          />
          <ToggleRow
            id="client-individual-scores"
            label={t('weldhr.portal.settings.clientCanSeeIndividualScores')}
            hint={t('weldhr.portal.settings.clientCanSeeIndividualScoresHint')}
            checked={data.clientCanSeeIndividualScores}
            disabled={update.isPending}
            onCheckedChange={(checked) => save({ clientCanSeeIndividualScores: checked })}
          />
        </CardContent>
      </Card>
    </div>
  );
}
