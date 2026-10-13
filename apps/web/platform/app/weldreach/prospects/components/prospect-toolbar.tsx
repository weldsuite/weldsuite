/** What the prospects table adds to its top bar, and the bar shown while rows are ticked. */

import { ListPlus, Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  reachProspectValidationSchema,
  type ReachProspectList,
  type ReachProspectValidation,
} from '@weldsuite/app-api-client/schemas/reach';
import { validationKeys } from '@/app/weldreach/components/engage/badges';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import { FilterSelect, type FilterSelectOption } from '@/app/weldreach/components/engage/kit';

const VALIDATIONS = reachProspectValidationSchema.options;

/** The validation results as filter options, named in the UI language. */
export function useValidationOptions(): FilterSelectOption[] {
  const t = useTranslations();
  return VALIDATIONS.map((value) => ({ value, label: t(validationKeys(value).label) }));
}

/** "Select all shown", at the left of the top bar. */
export function SelectAllCheckbox({
  allSelected,
  someSelected,
  hasRows,
  onToggle,
}: Readonly<{ allSelected: boolean; someSelected: boolean; hasRows: boolean; onToggle: () => void }>) {
  const t = useTranslations();
  let checked: boolean | 'indeterminate' = false;
  if (allSelected) checked = true;
  else if (someSelected) checked = 'indeterminate';

  return (
    <Checkbox
      checked={checked}
      onCheckedChange={onToggle}
      disabled={!hasRows}
      aria-label={t('reachEngage.prospects.selectAll')}
    />
  );
}

export function ImportButton({ onClick }: Readonly<{ onClick: () => void }>) {
  const t = useTranslations();
  return (
    <Button variant="outline" size="sm" className="h-8" onClick={onClick}>
      <Upload className="h-4 w-4 md:mr-1.5" />
      <span className="hidden md:inline">{t('reachEngage.prospects.import')}</span>
    </Button>
  );
}

/** The filter pills are hidden on small screens, so a row of plain selects stands in there. */
export function MobileFilters({
  lists,
  listId,
  validation,
  onListChange,
  onValidationChange,
}: Readonly<{
  lists: ReachProspectList[];
  listId: string | undefined;
  validation: ReachProspectValidation | undefined;
  onListChange: (listId: string | undefined) => void;
  onValidationChange: (validation: string | undefined) => void;
}>) {
  const t = useTranslations();
  const validationOptions = useValidationOptions();

  return (
    <div className="flex gap-2 border-b px-3 py-2 md:hidden">
      <FilterSelect
        value={validation}
        onChange={onValidationChange}
        options={validationOptions}
        allLabel={t('reachEngage.prospects.allValidations')}
        ariaLabel={t('reachEngage.prospects.validationFilter')}
        className="min-w-0 flex-1"
      />
      <FilterSelect
        value={listId}
        onChange={onListChange}
        options={lists.map((list) => ({ value: list.id, label: list.name }))}
        allLabel={t('reachEngage.prospects.lists.all')}
        ariaLabel={t('reachEngage.prospects.lists.title')}
        className="min-w-0 flex-1"
      />
    </div>
  );
}

/** Shown above the table while rows are ticked. */
export function SelectionBar({
  count,
  canAddToList,
  onAddToList,
  onClear,
}: Readonly<{ count: number; canAddToList: boolean; onAddToList: () => void; onClear: () => void }>) {
  const t = useTranslations();
  const format = useReachFormat();

  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-4 py-2 text-sm">
      <span className="font-medium">
        {t('reachEngage.prospects.selection.count', { count: format.number(count) })}
      </span>
      {canAddToList && (
        <Button variant="outline" size="sm" className="h-8" onClick={onAddToList}>
          <ListPlus className="mr-1.5 h-4 w-4" />
          {t('reachEngage.prospects.selection.addToList')}
        </Button>
      )}
      <Button variant="ghost" size="sm" className="h-8" onClick={onClear}>
        {t('reachEngage.prospects.selection.clear')}
      </Button>
    </div>
  );
}
