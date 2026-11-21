import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { VatCategory } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from '../../lib/text';
import { VAT_CATEGORIES, vatCategoryLabel } from '../../lib/vat';

/** What a select item holds for "no category of its own". */
const INHERIT = 'inherit';

/**
 * The VAT category of a product, or of a variant when `inheritFrom` is given:
 * a variant may leave it blank (`null`) to use its product's.
 */
export function VatCategorySelect({
  id,
  value,
  onChange,
  inheritFrom,
  disabled,
}: Readonly<{
  id: string;
  value: VatCategory | null;
  onChange: (value: VatCategory | null) => void;
  /** The product's category: set on a variant, which may inherit it. */
  inheritFrom?: string | null;
  disabled?: boolean;
}>) {
  const t = getTranslations('commerce').products.vat;
  const variant = inheritFrom !== undefined;
  return (
    <Select
      value={value ?? INHERIT}
      onValueChange={(next) => onChange(next === INHERIT ? null : (next as VatCategory))}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {variant && <SelectItem value={INHERIT}>{fill(t.inherit, { category: vatCategoryLabel(inheritFrom ?? 'standard') })}</SelectItem>}
        {VAT_CATEGORIES.map((category) => (
          <SelectItem key={category} value={category}>
            {vatCategoryLabel(category)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
