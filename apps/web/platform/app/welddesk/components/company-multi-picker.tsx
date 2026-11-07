import { useMemo, useState } from 'react';
import { Building2, Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { useI18n } from '@/lib/i18n/provider';
import { useCompanies, useCompany } from '@/components/objects/company/use-company-data';
import { RecordPickerMenu, type RecordPickerOption } from '@/components/objects/_shared/record-picker-menu';

interface CompanyMultiPickerProps {
  /** CRM company ids. */
  value: string[];
  onChange: (ids: string[]) => void;
  id?: string;
}

/** One picked company, named by its CRM record. */
function CompanyChip({ companyId, onRemove }: Readonly<{ companyId: string; onRemove: () => void }>) {
  const { t } = useI18n();
  const company = useCompany(companyId);
  const name = company.data?.data?.displayName ?? companyId;
  return (
    <span className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs">
      <Building2 className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <button
        type="button"
        className="flex-shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onRemove}
        aria-label={t.helpdesk.articleAudience.removeCompany.replace('{name}', name)}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * Pick WeldCRM companies: the audience of an article shown to `groups`, or of
 * an announcement shown to `specific_groups`. Readers count as part of a
 * company through the verified email of a CRM person linked to it.
 */
export function CompanyMultiPicker({ value, onChange, id }: Readonly<CompanyMultiPickerProps>) {
  const { t } = useI18n();
  const a = t.helpdesk.articleAudience;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 200);
  const query = useCompanies(debounced ? { limit: 25, search: debounced } : { limit: 25 });
  const options = useMemo<RecordPickerOption[]>(
    () =>
      (query.data?.data ?? []).map((company) => ({
        id: company.id,
        name: company.displayName,
        detail: company.email || company.industry,
      })),
    [query.data],
  );

  const toggle = (companyId: string) => {
    onChange(value.includes(companyId) ? value.filter((v) => v !== companyId) : [...value, companyId]);
  };

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((companyId) => (
            <CompanyChip key={companyId} companyId={companyId} onRemove={() => toggle(companyId)} />
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" size="sm" className="h-8">
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {a.addCompany}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
          <RecordPickerMenu
            options={options}
            kind="company"
            isLoading={query.isLoading}
            loadingLabel={a.loadingCompanies}
            emptyLabel={a.noCompaniesFound}
            isChecked={(option) => value.includes(option.id)}
            onSelect={(option) => toggle(option.id)}
            search={{ value: search, onChange: setSearch, placeholder: a.searchCompanies }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
