/**
 * "Link company to person" popover used in the Person panel's Companies tab.
 *
 * Mirror of `LinkPersonPopover` on the company side. Search-as-you-type over
 * `useCompanies({ search })`; picking a row creates a `person_companies` row
 * via `useLinkPersonToCompany`. Companies already linked are shown but
 * disabled so the constraint is obvious.
 */

import { useState } from 'react';
import { useDebounce } from '@/hooks/use-debounce';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Check, Plus } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { useLinkPersonToCompany } from '@/hooks/queries/use-person-companies-queries';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';

function companyInitial(c: Company): string {
  return (c.displayName?.[0] || c.name?.[0] || '?').toUpperCase();
}

interface LinkCompanyPopoverProps {
  personId: string;
  /** Company ids already linked to this person — disabled in the picker. */
  linkedCompanyIds: Set<string>;
}

export function LinkCompanyPopover({ personId, linkedCompanyIds }: LinkCompanyPopoverProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search, 200);

  const companiesQuery = useCompanies(
    debounced ? { limit: 25, search: debounced } : { limit: 25 },
  );
  const companies = companiesQuery.data?.data ?? [];

  const linkMut = useLinkPersonToCompany();

  const handlePick = (company: Company) => {
    if (linkedCompanyIds.has(company.id)) return;
    linkMut.mutate(
      { personId, companyId: company.id, isPrimary: false },
      {
        onSuccess: () => {
          toast.success(t('sweep.entities.companyLinked', { name: company.displayName }));
          setOpen(false);
          setSearch('');
        },
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          className="h-8 gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sweep.entities.addCompany')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('sweep.entities.searchCompaniesPlaceholder')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[260px]">
            {companiesQuery.isLoading ? (
              <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                {t('sweep.entities.loadingEllipsis')}
              </div>
            ) : companies.length === 0 ? (
              <CommandEmpty>{t('sweep.entities.noCompaniesFoundPeriod')}</CommandEmpty>
            ) : (
              <CommandGroup>
                {companies.map((c) => {
                  const already = linkedCompanyIds.has(c.id);
                  return (
                    <CommandItem
                      key={c.id}
                      value={c.displayName + (c.industry ? ` ${c.industry}` : '')}
                      disabled={already || linkMut.isPending}
                      onSelect={() => handlePick(c)}
                      className="flex items-center gap-2"
                    >
                      <Avatar className="h-6 w-6 rounded-md">
                        <AvatarImage
                          src={c.avatarUrl ?? undefined}
                          className="rounded-md object-cover"
                        />
                        <AvatarFallback className="rounded-md text-[10px]">
                          {companyInitial(c)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{c.displayName}</div>
                        {c.industry && (
                          <div className="text-xs text-muted-foreground truncate">{c.industry}</div>
                        )}
                      </div>
                      {already && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
