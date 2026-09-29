/**
 * "Add member" modal for a CRM list.
 *
 * The trigger button opens a multi-select picker: search the matching
 * identity table (companies or people based on `kind`), click results to
 * collect them as removable chips, then commit the whole batch to the list
 * with the footer "Add" button. Typing a name that isn't an existing record
 * surfaces an Attio-style "Create …" row that creates the record and drops it
 * straight into the selection.
 *
 * Already-member ids and already-picked ids are excluded from the results so
 * nothing is offered twice.
 */

import { useMemo, useState, useCallback, useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { useDebounce } from '@/hooks/use-debounce';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Plus, Building2, User, Loader2, X, Search, ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useCompanies, type Company } from '@/hooks/queries/use-companies-queries';
import { usePeople, type Person } from '@/hooks/queries/use-people-queries';
import { useAddListMembers, useListMembers, type ListKind } from '@/hooks/queries/use-lists-queries';
import { companyKeys } from '@/components/objects/company/use-company-data';
import { personKeys } from '@/components/objects/person/use-person-data';
import { QuickAddPersonForm } from '@/app/weldcrm/people/components/quick-add-person-form';
import { QuickAddCompanyForm } from '@/app/weldcrm/companies/components/quick-add-company-form';

interface AddMemberPickerProps {
  listId: string;
  kind: ListKind;
}

/** Normalised shape rendered both as a result row and as a selected chip. */
interface PickedEntity {
  id: string;
  label: string;
  email?: string | null;
  avatarUrl?: string | null;
}

function gravatar(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  return `https://www.gravatar.com/avatar/${encodeURIComponent(email.toLowerCase())}?d=mp&s=48`;
}

function initialOf(label: string): string {
  return (label.trim()[0] || '?').toUpperCase();
}


type Translate = ReturnType<typeof useTranslations>;

/** Fields shared by the company and person records the picker normalises. */
interface EntityLike {
  id: string;
  displayName: string;
  email?: string | null;
  avatarUrl?: string | null;
}

function companyToPicked(c: EntityLike): PickedEntity {
  return { id: c.id, label: c.displayName, email: c.email, avatarUrl: c.avatarUrl };
}

function personToPicked(p: EntityLike): PickedEntity {
  return {
    id: p.id,
    label: p.displayName,
    email: p.email,
    avatarUrl: p.avatarUrl ?? gravatar(p.email),
  };
}

/** Translation keys that differ between the company and the person picker. */
const LABEL_KEYS = {
  company: {
    trigger: 'crm.addMemberPicker.triggerAddCompany',
    title: 'crm.addMemberPicker.titleAddCompanies',
    placeholder: 'crm.addMemberPicker.placeholderSearchCompanies',
    createDialogTitle: 'crm.addMemberPicker.dialogTitleCreateCompany',
    entityNoun: 'crm.addMemberPicker.entityLabelCompany',
    noResults: 'crm.addMemberPicker.noCompaniesFound',
    addedMany: 'crm.addMemberPicker.addedCompanies',
  },
  person: {
    trigger: 'crm.addMemberPicker.triggerAddPerson',
    title: 'crm.addMemberPicker.titleAddPeople',
    placeholder: 'crm.addMemberPicker.placeholderSearchPeople',
    createDialogTitle: 'crm.addMemberPicker.dialogTitleCreatePerson',
    entityNoun: 'crm.addMemberPicker.entityLabelPerson',
    noResults: 'crm.addMemberPicker.noPeopleFound',
    addedMany: 'crm.addMemberPicker.addedPeople',
  },
} as const;

function addedToastMessage(t: Translate, count: number, firstLabel: string, addedManyKey: string): string {
  if (count === 1) return t('crm.addMemberPicker.addedOne', { label: firstLabel });
  return t(addedManyKey, { count });
}

// ── sub-components ───────────────────────────────────────────────────────────

function PickerHeader({
  creating,
  title,
  createDialogTitle,
  onBack,
}: Readonly<{ creating: boolean; title: string; createDialogTitle: string; onBack: () => void }>) {
  const t = useTranslations();
  return (
    <DialogHeader>
      {creating ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            aria-label={t('crm.addMemberPicker.ariaBack')}
            className="-ml-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground p-0"
          >
            <ChevronLeft className="size-[17px]" />
          </Button>
          <DialogTitle>{createDialogTitle}</DialogTitle>
        </div>
      ) : (
        <DialogTitle>{title}</DialogTitle>
      )}
    </DialogHeader>
  );
}

function CreateForm({
  isCompany,
  initialName,
  onCancel,
  onCreated,
}: Readonly<{
  isCompany: boolean;
  initialName: string;
  onCancel: () => void;
  onCreated: (entity: PickedEntity) => void;
}>) {
  if (isCompany) {
    return (
      <QuickAddCompanyForm
        initialName={initialName}
        onCancel={onCancel}
        onCreated={(c) => onCreated(companyToPicked(c))}
      />
    );
  }
  return (
    <QuickAddPersonForm
      initialName={initialName}
      onCancel={onCancel}
      onCreated={(p) => onCreated(personToPicked(p))}
    />
  );
}

/** Chip + search combobox field. */
function SearchField({
  picked,
  search,
  scrolled,
  placeholder,
  inputRef,
  onSearchChange,
  onKeyDown,
  onDeselect,
  onClearSearch,
}: Readonly<{
  picked: PickedEntity[];
  search: string;
  scrolled: boolean;
  placeholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (value: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onDeselect: (id: string) => void;
  onClearSearch: () => void;
}>) {
  const t = useTranslations();
  return (
    // Full-bleed wrapper reveals a divider line under it once the results list is scrolled.
    <div
      className={cn(
        '-mx-6 -mb-4 border-b px-6 pb-3 transition-colors duration-200',
        scrolled ? 'border-border' : 'border-transparent',
      )}
    >
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1.5 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
      >
        <Search className="size-4 shrink-0 text-muted-foreground" />

        {picked.map((chip) => (
          <span
            key={chip.id}
            className="inline-flex items-center gap-1.5 rounded-md border bg-muted/60 py-0.5 pl-1 pr-1 text-sm"
          >
            <Avatar className="size-5 rounded">
              <AvatarImage src={chip.avatarUrl ?? undefined} className="rounded object-cover" />
              <AvatarFallback className="rounded bg-muted text-[9px] font-medium">
                {initialOf(chip.label)}
              </AvatarFallback>
            </Avatar>
            <span className="max-w-[160px] truncate">{chip.label}</span>
            <Button
              type="button"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                onDeselect(chip.id);
              }}
              className="flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground p-0"
              aria-label={t('crm.addMemberPicker.ariaRemove', { label: chip.label })}
            >
              <X className="size-3" />
            </Button>
          </span>
        ))}

        <input
          ref={inputRef}
          autoFocus
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={picked.length ? t('crm.addMemberPicker.placeholderAddAnother') : placeholder}
          className="h-6 min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />

        {search && (
          <Button
            type="button"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onClearSearch();
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground p-0"
            aria-label={t('crm.addMemberPicker.ariaClearSearch')}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ResultRow({ entity, onSelect }: Readonly<{ entity: PickedEntity; onSelect: (entity: PickedEntity) => void }>) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onSelect(entity)}
      className="group flex w-full items-center gap-2.5 rounded-md px-0 py-1.5 text-left transition-colors h-auto justify-start"
    >
      <Avatar className="size-7 rounded-md">
        <AvatarImage src={entity.avatarUrl ?? undefined} className="rounded-md object-cover" />
        <AvatarFallback className="rounded-md bg-muted text-[11px] font-medium">
          {initialOf(entity.label)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{entity.label}</div>
        {entity.email && <div className="truncate text-xs text-muted-foreground">{entity.email}</div>}
      </div>
      <Plus className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Button>
  );
}

/**
 * Results — extends to the dialog's right edge so the scrollbar sits flush
 * against it; pr-6 keeps the rows within the normal 24px content margin.
 */
function ResultsList({
  isLoading,
  results,
  showEmpty,
  canCreate,
  EmptyIcon,
  noResultsMessage,
  createLabel,
  onScrolled,
  onSelect,
  onCreate,
}: Readonly<{
  isLoading: boolean;
  results: PickedEntity[];
  showEmpty: boolean;
  canCreate: boolean;
  EmptyIcon: typeof Building2;
  noResultsMessage: string;
  createLabel: string;
  onScrolled: (scrolled: boolean) => void;
  onSelect: (entity: PickedEntity) => void;
  onCreate: () => void;
}>) {
  const t = useTranslations();
  return (
    <div
      onScroll={(e) => onScrolled(e.currentTarget.scrollTop > 0)}
      className="-mr-6 max-h-[360px] min-h-[200px] overflow-y-auto pb-1 pr-6 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('crm.addMemberPicker.searching')}
        </div>
      ) : (
        <>
          {results.map((r) => (
            <ResultRow key={r.id} entity={r} onSelect={onSelect} />
          ))}

          {showEmpty && (
            <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
              <EmptyIcon className="size-5 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                {noResultsMessage}
              </p>
            </div>
          )}

          {canCreate && (
            <>
              {results.length > 0 && <div className="my-1.5 h-px bg-border" />}
              <Button
                type="button"
                variant="ghost"
                onClick={onCreate}
                className="flex w-full items-center gap-2.5 rounded-md px-0 py-1.5 text-left transition-colors h-auto justify-start"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                  <Plus className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{createLabel}</span>
              </Button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function PickerFooter({
  selectedCount,
  isPending,
  onAdd,
}: Readonly<{ selectedCount: number; isPending: boolean; onAdd: () => void }>) {
  const t = useTranslations();
  return (
    <DialogFooter className="-mx-6 -mt-4 flex-row items-center justify-between border-t px-6 pt-4">
      <span className="text-xs text-muted-foreground">
        {selectedCount > 0 ? t('crm.addMemberPicker.selectedCount', { count: selectedCount }) : ''}
      </span>
      <div className="flex items-center gap-2">
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t('crm.addMemberPicker.cancel')}
          </Button>
        </DialogClose>
        <Button
          type="button"
          onClick={onAdd}
          disabled={selectedCount === 0 || isPending}
          className="gap-1.5"
        >
          {isPending && <Loader2 className="size-4 animate-spin" />}
          {selectedCount
            ? t('crm.addMemberPicker.addButtonWithCount', { count: selectedCount })
            : t('crm.addMemberPicker.addButton')}
        </Button>
      </div>
    </DialogFooter>
  );
}

export function AddMemberPicker({ listId, kind }: Readonly<AddMemberPickerProps>) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<PickedEntity[]>([]);
  const [scrolled, setScrolled] = useState(false);
  // Which "page" of the dialog is showing: the search picker, or the inline
  // create form reached via the "Create …" row (Attio-style back navigation).
  const [creating, setCreating] = useState(false);
  const debounced = useDebounce(search, 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  const qc = useQueryClient();
  const addMembers = useAddListMembers();
  const { data: membersResp } = useListMembers(listId);

  const isCompany = kind === 'company';
  const trimmedSearch = search.trim();
  const canCreate = trimmedSearch.length > 0;

  // Ids already in the list (members) or already collected as chips — both
  // are filtered out of the result rows.
  const excludedIds = useMemo(() => {
    const ids = new Set((membersResp?.data ?? []).map((m) => m.entityId));
    picked.forEach((p) => ids.add(p.id));
    return ids;
  }, [membersResp, picked]);

  const companiesQuery = useCompanies(
    isCompany && open ? { limit: 25, search: debounced || undefined } : undefined,
  );
  const peopleQuery = usePeople(
    !isCompany && open ? { limit: 25, search: debounced || undefined } : undefined,
  );

  const results = useMemo<PickedEntity[]>(() => {
    if (isCompany) {
      return (companiesQuery.data?.data ?? [])
        .filter((c: Company) => !excludedIds.has(c.id))
        .map((c: Company) => companyToPicked(c));
    }
    return (peopleQuery.data?.data ?? [])
      .filter((p: Person) => !excludedIds.has(p.id))
      .map((p: Person) => personToPicked(p));
  }, [isCompany, companiesQuery.data, peopleQuery.data, excludedIds]);

  const isLoading = isCompany ? companiesQuery.isLoading : peopleQuery.isLoading;

  // ── selection ───────────────────────────────────────────────────────────
  const selectEntity = useCallback((entity: PickedEntity) => {
    setPicked((prev) => (prev.some((p) => p.id === entity.id) ? prev : [...prev, entity]));
    setSearch('');
  }, []);

  const deselect = useCallback((id: string) => {
    setPicked((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ── create-from-search ───────────────────────────────────────────────────
  // Typing a name with no match opens the full quick-add dialog (same form as
  // the People/Companies pages), prefilled with the search term. The created
  // record is dropped straight into the selection.
  const openCreateForm = useCallback(() => {
    if (!trimmedSearch) return;
    setCreating(true);
  }, [trimmedSearch]);

  // A record created from the inline form drops straight into the selection,
  // then navigates back to the picker page.
  const handleCreated = useCallback(
    (entity: PickedEntity) => {
      selectEntity(entity);
      setCreating(false);
    },
    [selectEntity],
  );

  // ── commit ────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setPicked([]);
    setSearch('');
    setScrolled(false);
    setCreating(false);
  }, []);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  const labelKeys = isCompany ? LABEL_KEYS.company : LABEL_KEYS.person;

  const handleAdd = () => {
    if (picked.length === 0 || addMembers.isPending) return;
    const count = picked.length;
    const firstLabel = picked[0]?.label ?? '';
    addMembers.mutate(
      { listId, data: { entityIds: picked.map((p) => p.id) } },
      {
        onSuccess: () => {
          toast.success(addedToastMessage(t, count, firstLabel, labelKeys.addedMany));
          reset();
          setOpen(false);
          qc.invalidateQueries({ queryKey: isCompany ? companyKeys.lists() : personKeys.lists() });
        },
      },
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0) selectEntity(results[0]);
      else if (canCreate) openCreateForm();
    } else if (e.key === 'Backspace' && search === '' && picked.length > 0) {
      deselect(picked[picked.length - 1].id);
    }
  };

  const handleClearSearch = () => {
    setSearch('');
    focusInput();
  };

  // ── labels ────────────────────────────────────────────────────────────────
  const Icon = isCompany ? Building2 : User;
  const showEmpty = !isLoading && results.length === 0 && !canCreate;

  return (
    <>
      <Button variant="default" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" />
        {t(labelKeys.trigger)}
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[36rem]" aria-describedby={undefined}>
          <PickerHeader
            creating={creating}
            title={t(labelKeys.title)}
            createDialogTitle={t(labelKeys.createDialogTitle)}
            onBack={() => setCreating(false)}
          />

          {creating ? (
            <CreateForm
              isCompany={isCompany}
              initialName={trimmedSearch}
              onCancel={() => setCreating(false)}
              onCreated={handleCreated}
            />
          ) : (
            <>
              <SearchField
                picked={picked}
                search={search}
                scrolled={scrolled}
                placeholder={t(labelKeys.placeholder)}
                inputRef={inputRef}
                onSearchChange={setSearch}
                onKeyDown={handleKeyDown}
                onDeselect={deselect}
                onClearSearch={handleClearSearch}
              />

              <ResultsList
                isLoading={isLoading}
                results={results}
                showEmpty={showEmpty}
                canCreate={canCreate}
                EmptyIcon={Icon}
                noResultsMessage={t(labelKeys.noResults)}
                createLabel={t('crm.addMemberPicker.createEntity', {
                  entityLabel: t(labelKeys.entityNoun),
                  name: trimmedSearch,
                })}
                onScrolled={setScrolled}
                onSelect={selectEntity}
                onCreate={openCreateForm}
              />

              <PickerFooter
                selectedCount={picked.length}
                isPending={addMembers.isPending}
                onAdd={handleAdd}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
