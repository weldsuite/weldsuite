/**
 * "Link person to company" popover used in the Company panel's People tab.
 *
 * Renders a search-as-you-type combobox over `usePeople({ search })`.
 * Picking a row creates a `person_companies` row via
 * `useLinkPersonToCompany`. People already linked to this company are
 * shown but disabled to make the constraint obvious.
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
import { Check, Plus, UserPlus } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePeople, type Person } from '@/hooks/queries/use-people-queries';
import { useLinkPersonToCompany } from '@/hooks/queries/use-person-companies-queries';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';

function personGravatar(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  return `https://www.gravatar.com/avatar/${encodeURIComponent(email.toLowerCase())}?d=mp&s=48`;
}

function personInitial(p: Person): string {
  const first = p.firstName?.[0] ?? '';
  const last = p.lastName?.[0] ?? '';
  return ((first + last) || p.displayName?.[0] || '?').toUpperCase();
}

interface LinkPersonPopoverProps {
  companyId: string;
  /** Person ids already linked to this company — disabled in the picker. */
  linkedPersonIds: Set<string>;
}

export function LinkPersonPopover({ companyId, linkedPersonIds }: Readonly<LinkPersonPopoverProps>) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
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
  const people = peopleQuery.data?.data ?? [];

  const linkMut = useLinkPersonToCompany();

  const handlePick = (person: Person) => {
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

  const openCreate = (query: string) => {
    setOpen(false);
    setCreateQuery(query);
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
      <PopoverContent align="end" className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t('sweep.entities.searchPeoplePlaceholder')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[260px]">
            {search.trim() && (
              <CommandGroup>
                <CommandItem
                  value={`__create__${search}`}
                  onSelect={() => openCreate(search.trim())}
                  className="flex items-center gap-2"
                >
                  <UserPlus className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">
                    {t('sweep.entities.createPersonFromSearch', { name: search.trim() })}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {peopleQuery.isLoading ? (
              <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                {t('sweep.entities.loadingEllipsis')}
              </div>
            ) : people.length === 0 ? (
              <CommandEmpty>{t('sweep.entities.noPeopleFoundPeriod')}</CommandEmpty>
            ) : (
              <CommandGroup>
                {people.map((p) => {
                  const already = linkedPersonIds.has(p.id);
                  return (
                    <CommandItem
                      key={p.id}
                      value={p.displayName + (p.email ? ` ${p.email}` : '')}
                      disabled={already || linkMut.isPending}
                      onSelect={() => handlePick(p)}
                      className="flex items-center gap-2"
                    >
                      <Avatar className="h-6 w-6 rounded-md">
                        <AvatarImage
                          src={p.avatarUrl ?? personGravatar(p.email)}
                          className="rounded-md object-cover"
                        />
                        <AvatarFallback className="rounded-md text-[10px]">
                          {personInitial(p)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{p.displayName}</div>
                        {p.email && (
                          <div className="text-xs text-muted-foreground truncate">{p.email}</div>
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
