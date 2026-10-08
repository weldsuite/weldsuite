import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useAccountingAccounts, useDimensionValues } from '@/hooks/queries/use-accounting-queries';
import type { Account, DimensionKind } from '@/lib/api/domains/weldbooks';

/** Radix Select cannot hold an empty value, so "nothing chosen" travels as this. */
const UNSET = '__unset__';

export interface AccountSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Account types to offer (`asset`, `liability`, `equity`, `revenue`, `expense`); all when omitted. */
  types?: readonly string[];
  /** The label of the "nothing chosen" option; without it the choice is required. */
  unsetLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  'data-testid'?: string;
  'aria-label'?: string;
}

/** The chart's accounts as a select: code and name, in code order, inactive accounts left out (unless one is the current value). */
export function AccountSelect({
  id,
  value,
  onChange,
  types,
  unsetLabel,
  placeholder,
  disabled,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: Readonly<AccountSelectProps>) {
  const query = useAccountingAccounts();
  const accounts = useMemo<Account[]>(() => {
    const all = query.data?.data ?? [];
    return all
      .filter((account) => (types ? types.includes(account.type) : true))
      .filter((account) => account.isActive !== false || account.id === value)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [query.data, types, value]);

  return (
    <Select
      value={value === '' ? (unsetLabel ? UNSET : '') : value}
      onValueChange={(next) => onChange(next === UNSET ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-testid={testId} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {unsetLabel ? <SelectItem value={UNSET}>{unsetLabel}</SelectItem> : null}
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.code} — {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface DimensionSelectProps {
  id?: string;
  dimension: DimensionKind;
  value: string;
  onChange: (value: string) => void;
  unsetLabel: string;
  disabled?: boolean;
}

/** Classes or locations (reporting dimensions) as a select, with "none" as the first choice. */
export function DimensionSelect({ id, dimension, value, onChange, unsetLabel, disabled }: Readonly<DimensionSelectProps>) {
  const query = useDimensionValues({ dimension, isActive: true });
  const values = query.data ?? [];
  return (
    <Select
      value={value === '' ? UNSET : value}
      onValueChange={(next) => onChange(next === UNSET ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>{unsetLabel}</SelectItem>
        {values.map((item) => (
          <SelectItem key={item.id} value={item.id}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
