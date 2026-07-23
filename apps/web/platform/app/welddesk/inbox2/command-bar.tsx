import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckSquare, Clock, RotateCcw, Users, Zap } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  useApplyDeskMacro,
  useDeskMacros,
  useManageDeskConversation,
  type DeskConversation,
} from '@/hooks/queries/use-desk-queries';

interface CommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: DeskConversation | null;
  onRequestAssign: () => void;
  onRequestSnooze: () => void;
}

/**
 * Local inbox-scoped Cmd+K palette. The platform's global command palette
 * (components/layout/command-palette.tsx) is a federated entity-search box,
 * not an action list, so it isn't extensible with inbox verbs — this is a
 * separate, page-local `CommandDialog` per the Phase 2 spec's fallback path.
 */
export function CommandBar({ open, onOpenChange, conversation, onRequestAssign, onRequestSnooze }: CommandBarProps) {
  const t = getTranslations('deskInbox2');
  const [query, setQuery] = useState('');
  const manage = useManageDeskConversation();
  const applyMacro = useApplyDeskMacro();
  const { data: macrosData } = useDeskMacros();
  const macros = macrosData?.data ?? [];

  const isClosed = conversation?.state === 'closed';

  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
    setQuery('');
  };

  const toggleClose = async () => {
    if (!conversation) return;
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: isClosed ? 'open' : 'close' } });
    } catch {
      toast.error(t.header.manageError);
    }
  };

  const runMacro = async (macroId: string) => {
    if (!conversation) return;
    try {
      await applyMacro.mutateAsync({ id: conversation.id, macroId });
      toast.success(t.composer.macroApplied);
    } catch {
      toast.error(t.composer.macroApplyError);
    }
  };

  const filteredMacros = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return macros.slice(0, 6);
    return macros.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 6);
  }, [macros, query]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t.commandBar.placeholder}>
      <CommandInput placeholder={t.commandBar.placeholder} value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>{t.list.empty}</CommandEmpty>
        {conversation && (
          <CommandGroup heading={t.commandBar.groupActions}>
            <CommandItem value="assign" onSelect={() => run(onRequestAssign)}>
              <Users className="h-4 w-4" />
              {t.commandBar.assign}
            </CommandItem>
            <CommandItem value="snooze" onSelect={() => run(onRequestSnooze)}>
              <Clock className="h-4 w-4" />
              {t.commandBar.snooze}
            </CommandItem>
            <CommandItem value="close-reopen" onSelect={() => run(toggleClose)}>
              {isClosed ? <RotateCcw className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
              {isClosed ? t.commandBar.reopen : t.commandBar.close}
            </CommandItem>
          </CommandGroup>
        )}
        {conversation && filteredMacros.length > 0 && (
          <CommandGroup heading={t.commandBar.groupMacros}>
            {filteredMacros.map((macro) => (
              <CommandItem key={macro.id} value={macro.name} onSelect={() => run(() => runMacro(macro.id))}>
                <Zap className="h-4 w-4" />
                {t.commandBar.applyMacro.replace('{name}', macro.name)}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
