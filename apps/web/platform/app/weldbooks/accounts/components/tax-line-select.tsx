import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { TaxLineCatalog } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { groupTaxLines, taxLineName } from '@/lib/weldbooks/tax-lines';

/** Select items can't have an empty value, so "no tax line" is a sentinel. */
export const NO_TAX_LINE = '__none__';

/** Translated name of a section of the return (`income`, `deduction`, ...); the server's label when unknown. */
export function useTaxSectionLabel() {
  const { t } = useI18n();
  const sections = t.weldbooksUs.setup.taxSections as Record<string, string>;
  return (key: string, fallback: string) => sections[key] ?? fallback;
}

interface TaxLineSelectProps {
  id?: string;
  /** The stored line code, or '' for none. */
  value: string;
  onChange: (code: string) => void;
  catalog: TaxLineCatalog | undefined;
  disabled?: boolean;
  /** Smaller trigger for use inside a table row. */
  compact?: boolean;
  'aria-label'?: string;
}

/**
 * The lines of the entity's income-tax return grouped by section, with a "no
 * tax line" choice. A stored line that isn't in the catalog (a line of the
 * previous return) is kept as an extra option so the field never goes blank.
 */
export function TaxLineSelect({ id, value, onChange, catalog, disabled, compact, ...rest }: Readonly<TaxLineSelectProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.setup.accounts;
  const sectionLabel = useTaxSectionLabel();
  const groups = useMemo(() => groupTaxLines(catalog), [catalog]);
  const known = !value || (catalog?.lines.some((line) => line.code === value) ?? false);

  return (
    <Select
      value={value || NO_TAX_LINE}
      onValueChange={(next) => onChange(next === NO_TAX_LINE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={compact ? 'h-8 w-full text-xs' : undefined} aria-label={rest['aria-label']}>
        <SelectValue placeholder={ta.selectTaxLine} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectItem value={NO_TAX_LINE}>{ta.noTaxLine}</SelectItem>
        {!known ? <SelectItem value={value}>{value}</SelectItem> : null}
        {groups.map((group) => (
          <SelectGroup key={group.key}>
            <SelectLabel>{sectionLabel(group.key, group.label)}</SelectLabel>
            {group.lines.map((line) => (
              <SelectItem key={line.code} value={line.code}>
                {taxLineName(line)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
