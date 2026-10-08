import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useAccountingCustomer, useAccountingCustomers } from '@/hooks/queries/use-accounting-queries';
import { cn } from '@/lib/utils';

export interface CustomerPickerProps {
  id?: string;
  /** The customer's id; empty for none. */
  value: string;
  onChange: (partyId: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Adds an entry on top that clears the choice ("All customers"). */
  allLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** The accessible name when no visible label points at the picker (the filter on the list). */
  ariaLabel?: string;
  className?: string;
}

const SEARCH_DELAY_MS = 250;

/** A search box over the entity's customers (the search runs on the server as you type). */
export function CustomerPicker({
  id,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  allLabel,
  disabled,
  invalid,
  describedBy,
  ariaLabel,
  className,
}: Readonly<CustomerPickerProps>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const results = useAccountingCustomers({ role: 'customer', search: debounced || undefined, pageSize: 25 });
  const selected = useAccountingCustomer(value);
  const options = results.data?.data ?? [];
  const selectedName = selected.data?.data?.name ?? options.find((c) => c.id === value)?.name ?? '';

  const choose = (partyId: string) => {
    onChange(partyId);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !value && !selectedName && 'text-muted-foreground', className)}
        >
          <span className="truncate">{value ? selectedName || value : (allLabel ?? placeholder)}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} />
          <CommandList>
            {results.isLoading ? null : <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {allLabel ? (
                <CommandItem value="__all__" onSelect={() => choose('')}>
                  <Check className={cn('mr-2 h-4 w-4', value ? 'opacity-0' : 'opacity-100')} aria-hidden />
                  {allLabel}
                </CommandItem>
              ) : null}
              {options.map((customer) => (
                <CommandItem key={customer.id} value={customer.id} onSelect={() => choose(customer.id)}>
                  <Check className={cn('mr-2 h-4 w-4', value === customer.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="truncate">{customer.name}</span>
                  {customer.email ? <span className="ml-2 truncate text-xs text-muted-foreground">{customer.email}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The name of a customer, loaded by id (the certificate rows only carry the id). */
export function CustomerName({ partyId, fallback = '—' }: Readonly<{ partyId: string; fallback?: string }>) {
  const customer = useAccountingCustomer(partyId);
  return <>{customer.data?.data?.name ?? (customer.isLoading ? '…' : fallback)}</>;
}
