import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useTranslations } from '@weldsuite/i18n/client';
import { LegalEntityPicker } from '@/components/legal-entity/legal-entity-picker';
import { useCurrentLegalEntity } from '@/hooks/use-current-legal-entity';

/**
 * The "Employer" field of the employee forms: the legal entity that employs the
 * person. Shown once the workspace has a legal entity WeldHR is enabled for; a
 * new employee defaults to the entity selected in the WeldHR sidebar (`value`
 * empty means that one, which `currentEntityId` reports).
 *
 * `lockToCurrent` (the create form): WeldHR requests carry the sidebar entity
 * as `X-Legal-Entity-Id` and hr-api refuses a different one in the body, so the
 * field only shows that entity. Without a current entity there is no header and
 * the picker stays.
 */
export function EmployerField({
  value,
  onChange,
  disabled,
  lockToCurrent,
}: Readonly<{ value: string | undefined; onChange: (id: string) => void; disabled?: boolean; lockToCurrent?: boolean }>) {
  const t = useTranslations();
  const { entityId: currentEntityId, entity, entities } = useCurrentLegalEntity({ app: 'weldhr' });
  if (entities.length === 0) return null;

  if (lockToCurrent && currentEntityId) {
    return (
      <div className="space-y-2" data-testid="employer-field">
        <Label htmlFor="employee-employer">{t('weldhr.employees.create.employer')}</Label>
        <Input id="employee-employer" value={entity?.name ?? ''} readOnly disabled />
        <p className="text-xs text-muted-foreground">{t('weldhr.employees.create.employerLockedHint')}</p>
      </div>
    );
  }

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
