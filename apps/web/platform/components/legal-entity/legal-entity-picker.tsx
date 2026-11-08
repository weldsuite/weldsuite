import type { LegalEntityApp } from '@weldsuite/app-api-client/schemas/legal-entities';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useLegalEntities } from '@/hooks/queries/use-legal-entities-queries';

interface LegalEntityPickerProps {
  value: string | null | undefined;
  onChange: (id: string) => void;
  /** Only the entities this app is enabled for. */
  app?: LegalEntityApp;
  /** Entity ids to leave out (for example the ones that already have the app). */
  excludeIds?: readonly string[];
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  /** Text shown instead of the list when there is nothing to pick. */
  emptyLabel?: string;
}

/**
 * Pick one of the workspace's legal entities (the employer of an employee, the entity
 * a WeldBooks administration is created from). When there is none, it says where to
 * create one: Settings → Legal entities.
 */
export function LegalEntityPicker({
  value,
  onChange,
  app,
  excludeIds,
  disabled,
  id,
  placeholder,
  emptyLabel,
}: Readonly<LegalEntityPickerProps>) {
  const { t } = useI18n();
  const tl = t.accounting.legalEntities;
  const router = useRouter();
  const { data: entities = [], isLoading } = useLegalEntities({ app });
  const options = entities.filter((e) => e.isActive && !excludeIds?.includes(e.id));

  if (!isLoading && options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="legal-entity-picker-empty">
        {emptyLabel ?? tl.pickerEmpty}{' '}
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={() => router.push('/settings/legal-entities')}
        >
          {tl.pickerCreate}
        </button>
      </p>
    );
  }

  return (
    <Select value={value ?? ''} onValueChange={onChange} disabled={disabled || isLoading}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder ?? tl.pickerPlaceholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((e) => (
          <SelectItem key={e.id} value={e.id}>
            {e.name}
            <span className="ml-2 text-xs text-muted-foreground">
              {[e.jurisdictionCode, e.baseCurrency].filter(Boolean).join(' · ')}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
