/** WeldHR workforce portal — master enable + capability toggles. */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWorkspace } from '@/contexts/workspace-context';
import { PageLoader } from '@/components/page-loader';
import { useHrPortalSettings, useUpdateHrPortalSettings } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { SettingsPage, SettingsSection, SettingRow } from '../../components/page-kit';
import { hrPortalUrl } from './portal-url';

interface FormState {
  isEnabled: boolean;
  employeePortalEnabled: boolean;
  clientPortalEnabled: boolean;
  employeeSelfClockIn: boolean;
  employeeLeaveRequests: boolean;
  clientCanSeeIndividualScores: boolean;
}

function toForm(data: FormState): FormState {
  return { ...data };
}

export function PortalSettingsTab() {
  const t = useTranslations();
  const { currentWorkspace } = useWorkspace();
  const { data, isLoading, error } = useHrPortalSettings();
  const update = useUpdateHrPortalSettings();
  const [state, setState] = useState<FormState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (data && !state) setState(toForm(data));
  }, [data, state]);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error) return <ErrorBanner error={errorMessage(error, t('weldhr.common.loadFailed'))} />;
  if (!data || !state) return null;

  const hasChanges = Object.keys(state).some((key) => state[key as keyof FormState] !== data[key as keyof FormState]);
  const portalUrl = hrPortalUrl(data.customDomain, currentWorkspace?.slug);

  function patch(key: keyof FormState, value: boolean) {
    setState((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!state) return;
    setFailure(null);
    try {
      await update.mutateAsync(state);
      toast.success(t('weldhr.portal.settings.saved'));
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  function cancel() {
    if (data) setState(toForm(data));
  }

  return (
    <SettingsPage
      title={t('weldhr.portal.settings.enableTitle')}
      description={data.isEnabled ? t('weldhr.portal.settings.enabledHint') : t('weldhr.portal.settings.disabledHint')}
      hasChanges={hasChanges}
      saving={update.isPending}
      onSave={() => void save()}
      onCancel={cancel}
    >
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <SettingsSection title={t('weldhr.portal.settings.enableTitle')}>
        <SettingRow label={t('weldhr.portal.settings.enableTitle')}>
          <Switch checked={state.isEnabled} onCheckedChange={(checked) => patch('isEnabled', checked)} />
        </SettingRow>

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
      </SettingsSection>

      <SettingsSection title={t('weldhr.portal.settings.accessTitle')}>
        <SettingRow label={t('weldhr.portal.settings.employeePortalEnabled')}>
          <Switch checked={state.employeePortalEnabled} onCheckedChange={(checked) => patch('employeePortalEnabled', checked)} />
        </SettingRow>
        <SettingRow label={t('weldhr.portal.settings.clientPortalEnabled')}>
          <Switch checked={state.clientPortalEnabled} onCheckedChange={(checked) => patch('clientPortalEnabled', checked)} />
        </SettingRow>
        <SettingRow label={t('weldhr.portal.settings.employeeSelfClockIn')}>
          <Switch checked={state.employeeSelfClockIn} onCheckedChange={(checked) => patch('employeeSelfClockIn', checked)} />
        </SettingRow>
        <SettingRow label={t('weldhr.portal.settings.employeeLeaveRequests')}>
          <Switch checked={state.employeeLeaveRequests} onCheckedChange={(checked) => patch('employeeLeaveRequests', checked)} />
        </SettingRow>
        <SettingRow
          label={t('weldhr.portal.settings.clientCanSeeIndividualScores')}
          description={t('weldhr.portal.settings.clientCanSeeIndividualScoresHint')}
        >
          <Switch
            checked={state.clientCanSeeIndividualScores}
            onCheckedChange={(checked) => patch('clientCanSeeIndividualScores', checked)}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
