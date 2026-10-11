/**
 * The menu for picking a person or a company: one row per record (avatar, name,
 * a muted detail such as the email address) and a "create new" row at the end.
 *
 * It is the suggestions menu of the WeldMail To field, lifted out so every
 * place that adds a person or a company shows the same menu: the mail composer,
 * the company panel's "Add person", the person panel's "Add company", the
 * calendar's attendees and the CRM task's linked record.
 *
 * - `RecordPickerMenu` is the whole list for a server-side search (the caller
 *   owns the query; cmdk's own filtering is off). Pass `search` to put the
 *   search field inside the menu; the mail composer leaves it out because its
 *   To field is the search field.
 * - `RecordPickerItem` / `RecordPickerCreateItem` are the rows on their own, for
 *   a menu that keeps its own `Command` (groups, client-side filtering).
 */

import { Building, Check, Loader2, Plus, User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Command, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { cn } from '@/lib/utils';

export type RecordPickerKind = 'person' | 'company';

export interface RecordPickerOption {
  id: string;
  name: string;
  /** Shown muted after the name: an email address, an industry. */
  detail?: string | null;
  avatarUrl?: string | null;
}

export function RecordPickerItem<T extends RecordPickerOption>({
  option,
  kind = 'person',
  value,
  onSelect,
  disabled,
  checked,
  className,
}: Readonly<{
  option: T;
  kind?: RecordPickerKind;
  /** cmdk value; set it to the searchable text when the menu filters client-side. */
  value?: string;
  onSelect: (option: T) => void;
  disabled?: boolean;
  /** Marks a record that is already picked. */
  checked?: boolean;
  className?: string;
}>) {
  const FallbackIcon = kind === 'company' ? Building : User;
  return (
    <CommandItem
      value={value ?? option.id}
      disabled={disabled}
      onSelect={() => onSelect(option)}
      className={className}
    >
      <Avatar className="h-5 w-5 !rounded-[7px] flex-shrink-0">
        {option.avatarUrl && (
          <AvatarImage src={option.avatarUrl} alt={option.name} className="!rounded-[7px] object-cover" />
        )}
        <AvatarFallback className="!rounded-[7px] bg-gray-200 dark:bg-muted-foreground/25">
          <FallbackIcon className="size-2.5" />
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-1 min-w-0 items-baseline gap-2">
        <span className={cn('font-medium truncate', option.detail && 'max-w-[60%]')}>{option.name}</span>
        {option.detail && (
          <span className="min-w-0 flex-1 text-xs text-muted-foreground truncate">{option.detail}</span>
        )}
      </div>
      {checked && <Check className="ml-auto size-3.5 text-primary" />}
    </CommandItem>
  );
}

export function RecordPickerCreateItem({
  label,
  onSelect,
  value = '__create-record',
}: Readonly<{ label: string; onSelect: () => void; value?: string }>) {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      <Plus />
      <span className="font-medium truncate">{label}</span>
    </CommandItem>
  );
}

export function RecordPickerMenu<T extends RecordPickerOption>({
  options,
  kind = 'person',
  isLoading = false,
  loadingLabel,
  onSelect,
  isDisabled,
  isChecked,
  createLabel,
  onCreate,
  search,
}: Readonly<{
  options: readonly T[];
  kind?: RecordPickerKind;
  /** Shows the loading row while there is nothing to list yet. */
  isLoading?: boolean;
  loadingLabel: string;
  onSelect: (option: T) => void;
  isDisabled?: (option: T) => boolean;
  isChecked?: (option: T) => boolean;
  /** The "create new" row at the end of the list; left out when there is no `onCreate`. */
  createLabel?: string;
  onCreate?: () => void;
  /** Renders the search field inside the menu. */
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
}>) {
  return (
    <Command shouldFilter={false} className="h-auto">
      {search && (
        <CommandInput placeholder={search.placeholder} value={search.value} onValueChange={search.onChange} />
      )}
      <CommandList className="max-h-[250px] p-1">
        {isLoading && options.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{loadingLabel}</span>
          </div>
        ) : (
          <>
            {options.map((option) => (
              <RecordPickerItem
                key={option.id}
                option={option}
                kind={kind}
                onSelect={onSelect}
                disabled={isDisabled?.(option)}
                checked={isChecked?.(option)}
              />
            ))}
            {onCreate && createLabel && <RecordPickerCreateItem label={createLabel} onSelect={onCreate} />}
          </>
        )}
      </CommandList>
    </Command>
  );
}
