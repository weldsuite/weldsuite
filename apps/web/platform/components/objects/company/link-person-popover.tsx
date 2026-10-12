/**
 * "Link person to company" popover used in the Company panel's People tab.
 *
 * Renders a search-as-you-type combobox over `usePeople({ search })`.
 * Picking a row creates a `person_companies` row via
 * `useLinkPersonToCompany`. People already linked to this company are
 * shown but disabled to make the constraint obvious.
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
import { usePeople, type Person } from '@/hooks/queries/use-people-queries';
import { useLinkPersonToCompany } from '@/hooks/queries/use-person-companies-queries';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';
import { RecordPickerMenu, type RecordPickerOption } from '@/components/objects/_shared/record-picker-menu';

interface LinkPersonPopoverProps {
  companyId: string;
  /** Person ids already linked to this company — disabled in the picker. */
  linkedPersonIds: Set<string>;
  /** Controlled open state, so the tab's empty-state action can open the picker. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type PersonOption = RecordPickerOption & { person: Person };

export function LinkPersonPopover({
  companyId,
  linkedPersonIds,
  open: controlledOpen,
  onOpenChange,
}: Readonly<LinkPersonPopoverProps>) {
  const t = useTranslations();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [search, setSearch] = useState('');
  const [createQuery, setCreateQuery] = useState<string | null>(null);
  const debounced = useDebounce(search, 200);

  // Query the People list; a `limit` of 25 is plenty for a combobox
  // surface. Empty search returns the most-recent people by the server's
  // default sort. inCrm: true matches the People table's own filter so
  // auto-created mail/helpdesk contacts (inCrm=false) aren't offered here.
  const peopleQuery = usePeople(
    debounced ? { limit: 25, search: debounced, inCrm: true } : { limit: 25, inCrm: true },
  );
  const options = useMemo<PersonOption[]>(
    () =>
      (peopleQuery.data?.data ?? []).map((person) => ({
        id: person.id,
        name: person.displayName,
        detail: person.email,
        avatarUrl: person.avatarUrl,
        person,
      })),
    [peopleQuery.data],
  );

  const linkMut = useLinkPersonToCompany();

  const handlePick = ({ person }: PersonOption) => {
    if (linkedPersonIds.has(person.id)) return;
    linkMut.mutate(
      { personId: person.id, companyId, isPrimary: false },
      {
        onSuccess: () => {
          toast.success(t('sweep.entities.personLinked', { name: person.displayName }));
          setOpen(false);
          setSearch('');
        },
      },
    );
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
          {t('sweep.entities.addPerson')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <RecordPickerMenu
          options={options}
          isLoading={peopleQuery.isLoading}
          loadingLabel={t('sweep.entities.loadingEllipsis')}
          onSelect={handlePick}
          isDisabled={(o) => linkedPersonIds.has(o.id) || linkMut.isPending}
          isChecked={(o) => linkedPersonIds.has(o.id)}
          createLabel={t('sweep.entities.createNewPerson')}
          onCreate={openCreate}
          search={{
            value: search,
            onChange: setSearch,
            placeholder: t('sweep.entities.searchPeoplePlaceholder'),
          }}
        />
      </PopoverContent>
    </Popover>
    <QuickAddPersonDialog
      open={createQuery !== null}
      onOpenChange={(next) => {
        if (!next) setCreateQuery(null);
      }}
      initialName={createQuery ?? ''}
      onCreated={(person) => {
        linkMut.mutate(
          { personId: person.id, companyId, isPrimary: false },
          {
            onSuccess: () => {
              toast.success(t('sweep.entities.personLinked', { name: person.displayName }));
            },
          },
        );
        setSearch('');
      }}
    />
    </>
  );
}
