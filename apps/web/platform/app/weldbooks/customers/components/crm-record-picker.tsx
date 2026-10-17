/**
 * "Find in WeldCRM" for the contact form: search WeldCRM's companies or people
 * and pick one. The same menu as the CRM's own "Add company" / "Add person"
 * pickers; its last row starts a new record from what was typed instead.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { useCompanies, type Company } from '@/components/objects/company/use-company-data';
import { usePeople, type Person } from '@/components/objects/person/use-person-data';
import { getCompanyAvatar } from '@/app/weldcrm/companies/config/company-grid-config';
import { logoDomainForCompany, useRowsWithCompanyLogos } from '@/lib/crm/company-logo';
import { RecordPickerMenu, type RecordPickerOption } from '@/components/objects/_shared/record-picker-menu';
import { useI18n } from '@/lib/i18n/provider';

interface PickerShellProps {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

function PickerShell({ label, open, onOpenChange, children }: Readonly<PickerShellProps>) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <Search className="h-3.5 w-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        {children}
      </PopoverContent>
    </Popover>
  );
}

interface CrmPickerProps<T> {
  label: string;
  onPick: (record: T) => void;
  /** The "New …" row: closes the menu and hands back what was typed. */
  onCreate: (typed: string) => void;
}

type CompanyOption = RecordPickerOption & { company: Company };

export function CrmCompanyPicker({ label, onPick, onCreate }: Readonly<CrmPickerProps<Company>>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 200);
  const query = useCompanies(debounced ? { limit: 25, search: debounced } : { limit: 25 });
  const companies = useMemo(() => query.data?.data ?? [], [query.data]);
  const withLogos = useRowsWithCompanyLogos(companies, logoDomainForCompany);
  const options = useMemo<CompanyOption[]>(
    () =>
      withLogos.map((company) => ({
        id: company.id,
        name: company.displayName,
        detail: company.email || company.industry,
        avatarUrl: getCompanyAvatar(company),
        company,
      })),
    [withLogos],
  );
  const typed = search.trim();

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  return (
    <PickerShell label={label} open={open} onOpenChange={setOpen}>
      <RecordPickerMenu
        options={options}
        kind="company"
        isLoading={query.isLoading}
        loadingLabel={tc.loadingCrm}
        onSelect={(option) => {
          onPick(option.company);
          close();
        }}
        createLabel={typed ? tc.createInCrm.company.replace('{name}', typed) : tc.createInCrmBlank.company}
        onCreate={() => {
          onCreate(typed);
          close();
        }}
        search={{ value: search, onChange: setSearch, placeholder: tc.searchCrm.company }}
      />
    </PickerShell>
  );
}

type PersonOption = RecordPickerOption & { person: Person };

interface CrmPersonPickerProps extends CrmPickerProps<Person> {
  /** Before anything is typed, list the people who work at this company. */
  companyId?: string | null;
}

export function CrmPersonPicker({ label, onPick, onCreate, companyId }: Readonly<CrmPersonPickerProps>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 200);
  let filters: Parameters<typeof usePeople>[0] = { limit: 25, inCrm: true };
  if (debounced) filters = { limit: 25, inCrm: true, search: debounced };
  else if (companyId) filters = { limit: 25, companyId };
  const query = usePeople(filters);
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
  const typed = search.trim();

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  return (
    <PickerShell label={label} open={open} onOpenChange={setOpen}>
      <RecordPickerMenu
        options={options}
        kind="person"
        isLoading={query.isLoading}
        loadingLabel={tc.loadingCrm}
        onSelect={(option) => {
          onPick(option.person);
          close();
        }}
        createLabel={typed ? tc.createInCrm.person.replace('{name}', typed) : tc.createInCrmBlank.person}
        onCreate={() => {
          onCreate(typed);
          close();
        }}
        search={{ value: search, onChange: setSearch, placeholder: tc.searchCrm.person }}
      />
    </PickerShell>
  );
}
