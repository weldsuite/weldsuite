/** "Work locations" picker of the employee dialogs: where this employee may clock in. */

import { useMemo } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { MultiSelect, type MultiSelectOption } from '@weldsuite/ui/components/multi-select';
import { useTranslations } from '@weldsuite/i18n/client';
import { useHrWorkLocations } from '@/hooks/queries/use-weldhr-queries';

/** The work locations that exist (inactive ones too, so an assignment to one stays visible) as picker options. */
export function useWorkLocationOptions(): MultiSelectOption[] {
  const t = useTranslations();
  const { data } = useHrWorkLocations({ includeInactive: true });
  return useMemo(
    () =>
      (data ?? []).map((location) => ({
        value: location.id,
        label: location.isActive ? location.name : `${location.name} (${t('weldhr.settings.workLocations.inactive').toLowerCase()})`,
      })),
    [data, t],
  );
}

/**
 * Empty means any work location. Hidden while the workspace has no work
 * locations, so people who do not use the feature never see it.
 */
export function WorkLocationsField({
  options,
  value,
  onChange,
}: Readonly<{ options: MultiSelectOption[]; value: string[]; onChange: (value: string[]) => void }>) {
  const t = useTranslations();
  if (options.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <Label>{t('weldhr.employees.create.workLocations')}</Label>
      <MultiSelect
        modal
        options={options}
        value={value}
        onChange={onChange}
        placeholder={t('weldhr.employees.create.workLocationsPlaceholder')}
      />
      <p className="text-xs text-muted-foreground">{t('weldhr.employees.create.workLocationsHint')}</p>
    </div>
  );
}
