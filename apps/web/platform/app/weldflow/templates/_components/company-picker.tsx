import { useMemo, useState } from 'react';
import { ChevronsUpDown, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useDebounce } from '@/hooks/use-debounce';
import { useI18n } from '@/lib/i18n/provider';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { RecordPickerMenu, type RecordPickerOption } from '@/components/objects/_shared/record-picker-menu';

export interface PickedCompany {
  id: string;
  name: string;
}

interface CompanyPickerProps {
  id?: string;
  value: PickedCompany | null;
  onChange: (company: PickedCompany | null) => void;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** Pick a WeldCRM company as the client; optional, so it can be cleared. */
export function CompanyPicker({ id, value, onChange, ...aria }: Readonly<CompanyPickerProps>) {
  const { t } = useI18n();
  const copy = t.flowClosing.templates.form;
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

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="min-w-0 flex-1 justify-between font-normal" {...aria}>
            <span className={value ? 'truncate' : 'truncate text-muted-foreground'}>{value ? value.name : copy.clientPlaceholder}</span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
          <RecordPickerMenu
            options={options}
            kind="company"
            isLoading={query.isLoading}
            loadingLabel={copy.clientLoading}
            isChecked={(option) => option.id === value?.id}
            onSelect={(option) => {
              onChange({ id: option.id, name: option.name });
              setOpen(false);
              setSearch('');
            }}
            search={{ value: search, onChange: setSearch, placeholder: copy.clientSearch }}
          />
        </PopoverContent>
      </Popover>
      {value ? (
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={copy.clientClear} onClick={() => onChange(null)}>
          <X aria-hidden className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}
