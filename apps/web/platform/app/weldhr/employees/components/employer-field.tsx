import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import { LegalEntityPicker } from '@/components/legal-entity/legal-entity-picker';
import { useCurrentLegalEntity } from '@/hooks/use-current-legal-entity';

/**
 * The "Employer" field of the employee forms: the legal entity that employs the
 * person. Shown once the workspace has a legal entity WeldHR is enabled for; a
 * new employee defaults to the entity selected in the WeldHR sidebar (`value`
 * empty means that one, which `currentEntityId` reports).
 */
export function EmployerField({
  value,
  onChange,
  disabled,
}: Readonly<{ value: string | undefined; onChange: (id: string) => void; disabled?: boolean }>) {
  const t = useTranslations();
  const { entityId: currentEntityId, entities } = useCurrentLegalEntity({ app: 'weldhr' });
  if (entities.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="employer-field">
      <Label htmlFor="employee-employer">{t('weldhr.employees.create.employer')}</Label>
      <LegalEntityPicker
        id="employee-employer"
        app="weldhr"
        value={value || currentEntityId}
        onChange={onChange}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">{t('weldhr.employees.create.employerHint')}</p>
    </div>
  );
}
