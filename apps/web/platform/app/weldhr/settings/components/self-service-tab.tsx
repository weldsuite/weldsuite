/** WeldHR settings — what employees may do for themselves in My HR. */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { useHrSettings, useUpdateHrSettings } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { SettingsPage, SettingsSection, SettingRow } from '../../components/page-kit';

interface FormState {
  employeeSelfClockIn: boolean;
  employeeLeaveRequests: boolean;
  employeeDeclarations: boolean;
}

function toForm(data: FormState): FormState {
  return {
    employeeSelfClockIn: data.employeeSelfClockIn,
    employeeLeaveRequests: data.employeeLeaveRequests,
    employeeDeclarations: data.employeeDeclarations,
  };
}

export function SelfServiceTab() {
  const t = useTranslations();
  const { data, isLoading, error } = useHrSettings();
  const update = useUpdateHrSettings();
  const [state, setState] = useState<FormState | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (data && !state) setState(toForm(data));
  }, [data, state]);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (error) return <ErrorBanner error={errorMessage(error, t('weldhr.common.loadFailed'))} />;
  if (!data || !state) return null;

  const saved = toForm(data);
  const hasChanges = (Object.keys(state) as Array<keyof FormState>).some((key) => state[key] !== saved[key]);

  function patch(key: keyof FormState, value: boolean) {
    setState((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!state) return;
    setFailure(null);
    try {
      await update.mutateAsync(state);
      toast.success(t('weldhr.settings.selfService.saved'));
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  return (
    <SettingsPage
      title={t('weldhr.settings.selfService.title')}
      description={t('weldhr.settings.selfService.description')}
      hasChanges={hasChanges}
      saving={update.isPending}
      onSave={() => void save()}
      onCancel={() => setState(saved)}
    >
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <SettingsSection title={t('weldhr.settings.selfService.title')}>
        <SettingRow label={t('weldhr.settings.selfService.clockIn')}>
          <Switch checked={state.employeeSelfClockIn} onCheckedChange={(checked) => patch('employeeSelfClockIn', checked)} />
        </SettingRow>
        <SettingRow label={t('weldhr.settings.selfService.leaveRequests')}>
          <Switch checked={state.employeeLeaveRequests} onCheckedChange={(checked) => patch('employeeLeaveRequests', checked)} />
        </SettingRow>
        <SettingRow label={t('weldhr.settings.selfService.declarations')}>
          <Switch checked={state.employeeDeclarations} onCheckedChange={(checked) => patch('employeeDeclarations', checked)} />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
