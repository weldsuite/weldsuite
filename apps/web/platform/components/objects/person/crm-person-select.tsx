/**
 * A form field for picking one WeldCRM person: the trigger shows who is
 * picked, the menu searches the CRM's people server-side. The same menu as
 * the CRM's own "Add person" pickers (`RecordPickerMenu`).
 *
 * The value is the person's id. The picked person is kept locally for the
 * label; an id passed in from outside is looked up once.
 */

import { useMemo, useState } from 'react';
import { ChevronsUpDown, User, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { RecordPickerMenu, type RecordPickerOption } from '@/components/objects/_shared/record-picker-menu';
import { usePeople, usePerson, type Person } from './use-person-data';

type PersonOption = RecordPickerOption & { person: Person };

export interface CrmPersonSelectProps {
  /** The picked person's id, or '' for nobody. */
  value: string;
  onChange: (personId: string, person: Person | null) => void;
  /** Trigger text while nobody is picked. */
  placeholder: string;
  searchPlaceholder: string;
  /** People that cannot be picked again (already on the list, say). */
  excludeIds?: ReadonlySet<string>;
  /** Shows a clear button next to the trigger once someone is picked. */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export function CrmPersonSelect({
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  excludeIds,
  clearable = false,
  disabled = false,
  id,
  className,
}: Readonly<CrmPersonSelectProps>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Person | null>(null);
  const debounced = useDebounce(search, 200);
  const query = usePeople(debounced ? { limit: 25, inCrm: true, search: debounced } : { limit: 25, inCrm: true });
  // Only for an id set from outside; a person picked here is already known.
  const known = picked && picked.id === value ? picked : null;
  const lookup = usePerson(value, Boolean(value) && !known);
  const looked = (lookup.data as { data?: Person } | undefined)?.data ?? null;
  const current = known ?? (value ? looked : null);

  const options = useMemo<PersonOption[]>(
    () =>
      (query.data?.data ?? []).map((person) => ({
        id: person.id,
        name: person.displayName,
        detail: person.email,
        avatarUrl: person.avatarUrl,
        person,
      })),
    [query.data],
  );

  const pick = (person: Person | null) => {
    setPicked(person);
    onChange(person?.id ?? '', person);
    setOpen(false);
    setSearch('');
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="h-8 min-w-56 flex-1 justify-between gap-2 px-2 font-normal"
          >
            {current ? (
              <span className="flex min-w-0 items-center gap-2">
                <Avatar className="h-5 w-5 flex-shrink-0">
                  {current.avatarUrl ? <AvatarImage src={current.avatarUrl} alt={current.displayName} className="object-cover" /> : null}
                  <AvatarFallback className="bg-gray-200 dark:bg-muted-foreground/25">
                    <User className="size-2.5" />
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{current.displayName}</span>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">{value ? t.common.ui.table.loading : placeholder}</span>
            )}
            <ChevronsUpDown className="size-3.5 flex-shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
          <RecordPickerMenu
            options={options}
            kind="person"
            isLoading={query.isLoading}
            loadingLabel={t.common.ui.table.loading}
            emptyLabel={t.common.ui.table.noResults}
            isDisabled={(option) => Boolean(excludeIds?.has(option.id))}
            isChecked={(option) => option.id === value}
            onSelect={(option) => pick(option.person)}
            search={{ value: search, onChange: setSearch, placeholder: searchPlaceholder }}
          />
        </PopoverContent>
      </Popover>
      {clearable && value && !disabled ? (
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label={t.common.ui.form.clear} onClick={() => pick(null)}>
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
