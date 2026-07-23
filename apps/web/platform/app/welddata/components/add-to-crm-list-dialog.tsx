import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { SavedLeadInput } from '@weldsuite/app-api-client/schemas/welddata';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useCreateList, useLists } from '@/hooks/queries/use-lists-queries';
import { useConvertToCrmList } from '@/hooks/queries/use-welddata-queries';

interface AddToCrmListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Person leads go to person lists; company leads to company lists. */
  kind: 'person' | 'company';
  /** Inline search rows to convert (search grid). */
  leads?: SavedLeadInput[];
  /** Saved WeldData lead ids to convert (lists grid). */
  leadIds?: string[];
  /** Called after a successful add — used to clear the grid selection. */
  onAdded?: () => void;
}

/**
 * Picks an existing CRM list (filtered to the lead kind) — or creates one
 * inline — then converts the given leads to CRM and adds the resulting
 * person/company to that list, all server-side in one call.
 */
export function AddToCrmListDialog({
  open,
  onOpenChange,
  kind,
  leads,
  leadIds,
  onAdded,
}: AddToCrmListDialogProps) {
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const { data: listsResp, isLoading } = useLists(kind);
  const createList = useCreateList();
  const convertToList = useConvertToCrmList();

  const lists = useMemo(() => listsResp?.data ?? [], [listsResp]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? lists.filter((l) => l.name.toLowerCase().includes(q)) : lists;
  }, [lists, query]);

  const trimmed = query.trim();
  const showCreate =
    trimmed.length > 0 && !lists.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());
  const pending = convertToList.isPending || createList.isPending;

  // Make the kind filter explicit — users were confused why only some lists
  // showed. The badge + description spell out that a CRM list is single-type.
  const isCompany = kind === 'company';
  const kindLabel = isCompany
    ? t('welddata.crmList.companiesLabel')
    : t('welddata.crmList.peopleLabel');
  const description = isCompany
    ? t('welddata.crmList.companyDescription')
    : t('welddata.crmList.personDescription');
  const emptyText = isCompany
    ? t('welddata.crmList.companyEmpty')
    : t('welddata.crmList.personEmpty');

  function close() {
    onOpenChange(false);
    setQuery('');
  }

  async function addToList(listId: string) {
    try {
      const res = await convertToList.mutateAsync({ listId, leads, leadIds, createCompany: true });
      toast.success(t('welddata.toasts.addedToCrmList', { count: res.added }));
      close();
      onAdded?.();
    } catch {
      toast.error(t('welddata.toasts.addToCrmListFailed'));
    }
  }

  async function createAndAdd() {
    try {
      const created = await createList.mutateAsync({
        name: trimmed,
        kind,
        type: 'static',
        color: 'bg-blue-500',
        icon: 'List',
      });
      await addToList(created.data.id);
    } catch {
      toast.error(t('welddata.toasts.addToCrmListFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md overflow-hidden p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle className="flex items-center gap-2">
            {t('welddata.crmList.dialogTitle')}
            <Badge variant="secondary" className="font-normal">
              {kindLabel}
            </Badge>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* shouldFilter=false — we filter manually so the inline "create" row
            can show alongside matches. */}
        <Command shouldFilter={false} className="border-t">
          <CommandInput
            placeholder={t('welddata.crmList.searchPlaceholder')}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {!isLoading && filtered.length === 0 && !showCreate && (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            <CommandGroup>
              {filtered.map((list) => (
                <CommandItem
                  key={list.id}
                  value={list.id}
                  onSelect={() => addToList(list.id)}
                  disabled={pending}
                  className="flex items-center gap-2"
                >
                  <div className={`h-3 w-3 rounded ${list.color}`} />
                  {list.name}
                </CommandItem>
              ))}
              {showCreate && (
                <CommandItem
                  value="__create__"
                  onSelect={createAndAdd}
                  disabled={pending}
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  {t('welddata.crmList.create', { name: trimmed })}
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
