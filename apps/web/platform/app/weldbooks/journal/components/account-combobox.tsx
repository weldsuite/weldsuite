import { useMemo, useState } from 'react';
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
import type { Account } from '@/lib/api/domains/weldbooks';
import { cn } from '@/lib/utils';

export interface AccountComboboxProps {
  accounts: readonly Pick<Account, 'id' | 'code' | 'name'>[];
  /** The account's id; empty for none. */
  value: string;
  onChange: (accountId: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  className?: string;
}

/** The chart of accounts as a search box: type part of a code or name to narrow a long chart down. */
export function AccountCombobox({
  accounts,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  className,
}: Readonly<AccountComboboxProps>) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () => [...accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [accounts],
  );
  const selected = sorted.find((account) => account.id === value);

  const choose = (accountId: string) => {
    onChange(accountId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('w-full justify-between font-normal', !selected && 'text-muted-foreground', className)}
        >
          <span className="truncate">{selected ? `${selected.code} — ${selected.name}` : placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {sorted.map((account) => (
                <CommandItem
                  key={account.id}
                  value={`${account.code} ${account.name} ${account.id}`}
                  onSelect={() => choose(account.id)}
                >
                  <Check className={cn('mr-2 h-4 w-4', value === account.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  <span className="truncate">
                    {account.code} — {account.name}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
