/**
 * "Link company to person" popover used in the Person panel's Companies tab.
 *
 * Mirror of `LinkPersonPopover` on the company side. Search-as-you-type over
 * `useCompanies({ search })`; picking a row creates a `person_companies` row
 * via `useLinkPersonToCompany`. Companies already linked are shown but
 * disabled so the constraint is obvious. "Create new company" opens the
 * quick-add dialog and links the company it creates.
 */

import { useMemo, useState } from 'react';
import { useDebounce } from '@/hooks/use-debounce';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { useLinkPersonToCompany } from '@/hooks/queries/use-person-companies-queries';
import { QuickAddCompanyDialog } from '@/app/weldcrm/companies/components/quick-add-company-dialog';
import { getCompanyAvatar } from '@/app/weldcrm/companies/config/company-grid-config';
import { logoDomainForCompany, useRowsWithCompanyLogos } from '@/lib/crm/company-logo';
import { RecordPickerMenu, type RecordPickerOption } from '@/components/objects/_shared/record-picker-menu';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';

interface LinkCompanyPopoverProps {
  personId: string;
  /** Company ids already linked to this person — disabled in the picker. */
  linkedCompanyIds: Set<string>;
  /** Controlled open state, so the tab's empty-state action can open the picker. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type CompanyOption = RecordPickerOption & { company: Company };

export function LinkCompanyPopover({
  personId,
  linkedCompanyIds,
  open: controlledOpen,
  onOpenChange,
}: Readonly<LinkCompanyPopoverProps>) {
  const t = useTranslations();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [search, setSearch] = useState('');
  const [createQuery, setCreateQuery] = useState<string | null>(null);
  const debounced = useDebounce(search, 200);

  const companiesQuery = useCompanies(
    debounced ? { limit: 25, search: debounced } : { limit: 25 },
  );
  const companies = useMemo(() => companiesQuery.data?.data ?? [], [companiesQuery.data]);
  // Same avatar as the Companies grid: the company's own image, else the logo
  // our API found on its website.
  const companiesWithLogos = useRowsWithCompanyLogos(companies, logoDomainForCompany);
  const options = useMemo<CompanyOption[]>(
    () =>
      companiesWithLogos.map((company) => ({
        id: company.id,
        name: company.displayName,
        detail: company.industry,
        avatarUrl: getCompanyAvatar(company),
        company,
      })),
    [companiesWithLogos],
  );

  const linkMut = useLinkPersonToCompany();

  const link = (company: Company, onLinked?: () => void) => {
    linkMut.mutate(
      { personId, companyId: company.id, isPrimary: false },
      {
        onSuccess: () => {
          toast.success(t('sweep.entities.companyLinked', { name: company.displayName }));
          onLinked?.();
        },
      },
    );
  };

  const handlePick = ({ company }: CompanyOption) => {
    if (linkedCompanyIds.has(company.id)) return;
    link(company, () => {
      setOpen(false);
      setSearch('');
    });
  };

  const openCreate = () => {
    setOpen(false);
    setCreateQuery(search.trim());
  };

  return (
    <>
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
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
          <RecordPickerMenu
            options={options}
            kind="company"
            isLoading={companiesQuery.isLoading}
            loadingLabel={t('sweep.entities.loadingEllipsis')}
            onSelect={handlePick}
            isDisabled={(o) => linkedCompanyIds.has(o.id) || linkMut.isPending}
            isChecked={(o) => linkedCompanyIds.has(o.id)}
            createLabel={t('sweep.entities.createNewCompany')}
            onCreate={openCreate}
            search={{
              value: search,
              onChange: setSearch,
              placeholder: t('sweep.entities.searchCompaniesPlaceholder'),
            }}
          />
        </PopoverContent>
      </Popover>
      <QuickAddCompanyDialog
        open={createQuery !== null}
        onOpenChange={(next) => {
          if (!next) setCreateQuery(null);
        }}
        initialName={createQuery ?? ''}
        onCreated={(company) => {
          link(company);
          setSearch('');
        }}
      />
    </>
  );
}
