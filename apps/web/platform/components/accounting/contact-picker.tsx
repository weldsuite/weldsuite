/**
 * The customer / supplier picker of the WeldBooks document forms (invoice, bill, recurring invoice).
 *
 * It asks the server as you type (`role` and `search` of the contacts list), so every contact can be
 * found, not only the first page of the list. The chosen contact is read by its own id, so it stays
 * in the trigger whatever the search lists. Built on the library's `Autocomplete`.
 */

import { useCallback, useMemo } from 'react';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import { useAccountingContactSearch, useAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import type { Customer } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

type PickedContact = Pick<Customer, 'id' | 'name' | 'email'>;

export interface ContactPickerProps {
  /** Which contacts are offered: customers (and both-role contacts) or suppliers (and both). */
  role: 'customer' | 'supplier';
  /** The contact's id; empty for none. */
  value: string;
  onChange: (contactId: string) => void;
  /** Id of the trigger, so a `<label htmlFor>` names it. */
  id?: string;
  /** Shown while nothing is picked. */
  placeholder: string;
  /** Shown in the search box of the open list. */
  searchPlaceholder: string;
  invalid?: boolean;
  disabled?: boolean;
  'aria-describedby'?: string;
}

/** What the list shows of a contact: its name, with the email under it when both are known. */
export function contactOption(contact: PickedContact): AutocompleteOption {
  const name = contact.name || contact.email || contact.id;
  return {
    value: contact.id,
    label: name,
    description: contact.name && contact.email ? contact.email : undefined,
  };
}

export function ContactPicker({
  role,
  value,
  onChange,
  id,
  placeholder,
  searchPlaceholder,
  invalid,
  disabled,
  'aria-describedby': describedBy,
}: Readonly<ContactPickerProps>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const searchContacts = useAccountingContactSearch(role);
  const selected = useAccountingCustomer(value).data?.data;

  const search = useCallback(
    async (query: string) => (await searchContacts(query)).map(contactOption),
    [searchContacts],
  );
  // The picked contact is read by its id: the list holds one page, and a search may not include it.
  const selectedOption = useMemo(() => (selected && selected.id === value ? contactOption(selected) : undefined), [selected, value]);

  return (
    <Autocomplete
      id={id}
      value={value}
      // Choosing the picked contact again would clear it; a document always has its contact.
      onValueChange={(next) => next && onChange(next)}
      onSearch={search}
      selectedOption={selectedOption}
      // An empty search lists the first contacts as soon as the list opens.
      minSearchLength={0}
      debounceMs={250}
      clearable={false}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      searchingText={tc.pickerSearching}
      emptyText={tc.pickerNoResults}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      disabled={disabled}
    />
  );
}
