import { Badge } from '@weldsuite/ui/components/badge';
import { Label } from '@weldsuite/ui/components/label';
import { usePayrollCategories } from '@/hooks/queries/use-weldbooks-assets-queries';
import {
  PAYROLL_CATEGORY_KEYS,
  type AccountMapping,
  type PayrollCategory,
  type PayrollCategoryKey,
} from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { AccountSelect } from '../../fixed-assets/components/account-select';

/** What the server says about the categories, until it answers (or if it cannot). */
const FALLBACK_CATEGORIES: PayrollCategory[] = PAYROLL_CATEGORY_KEYS.map((key) => ({
  key,
  label: key,
  side: ['employee_taxes', 'employee_deductions', 'payroll_liabilities', 'net_pay'].includes(key) ? 'credit' : 'debit',
  required: key === 'net_pay',
}));

/** The account types each category can post to. */
const ACCOUNT_TYPES: Record<PayrollCategoryKey, readonly string[]> = {
  gross_wages: ['expense'],
  employer_taxes: ['expense'],
  employer_benefits: ['expense'],
  reimbursements: ['expense'],
  owners_draw: ['equity'],
  employee_taxes: ['liability'],
  employee_deductions: ['liability'],
  payroll_liabilities: ['liability'],
  net_pay: ['asset', 'liability'],
};

interface CategoryMappingProps {
  value: AccountMapping;
  onChange: (next: AccountMapping) => void;
  idPrefix: string;
  disabled?: boolean;
}

/** Each part of a payroll and the account it posts to. Categories left unset use the chart's payroll accounts; the net pay account is required. */
export function CategoryMapping({ value, onChange, idPrefix, disabled }: Readonly<CategoryMappingProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.assets.payroll;
  const query = usePayrollCategories();
  const categories = query.data ?? FALLBACK_CATEGORIES;
  const names = tp.categories as Record<string, string>;
  const help = tp.categoryHelp as Record<string, string>;

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="category-mapping">
      {categories.map((category) => {
        const id = `${idPrefix}-${category.key}`;
        const selected = value[category.key] ?? '';
        return (
          <div key={category.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={id}>{names[category.key] ?? category.label}</Label>
              <Badge variant="outline">{category.side === 'debit' ? tp.sides.debit : tp.sides.credit}</Badge>
            </div>
            <AccountSelect
              id={id}
              value={selected}
              onChange={(next) => {
                const updated: AccountMapping = { ...value };
                if (next) updated[category.key] = next;
                else delete updated[category.key];
                onChange(updated);
              }}
              types={ACCOUNT_TYPES[category.key]}
              unsetLabel={category.required ? undefined : tp.defaultAccount}
              placeholder={category.required ? tp.chooseAccount : undefined}
              disabled={disabled}
              data-testid={`mapping-${category.key}`}
            />
            <p className="text-xs text-muted-foreground">
              {help[category.key]}
              {category.required ? ` ${tp.required}` : ''}
            </p>
          </div>
        );
      })}
    </div>
  );
}
