import { useState, type ReactNode } from 'react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import { useDeskConversationSearch } from '@/hooks/queries/use-desk-link-queries';

/** "#12 Checkout fails · Mo" for a conversation in a list. */
export function ticketLabel(conversation: Pick<DeskConversation, 'conversationNumber' | 'title'>): string {
  const t = getTranslations('helpdesk').ticketLinks;
  return `#${conversation.conversationNumber} ${conversation.title || t.untitled}`;
}

export function customerLabel(conversation: Pick<DeskConversation, 'name' | 'email'>): string {
  return conversation.name || conversation.email || getTranslations('helpdesk').ticketLinks.noCustomer;
}

/**
 * Pick another conversation (to link to, or merge into) from the inbox
 * search. `exclude` leaves out the ones that make no sense to pick.
 */
export function TicketPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  exclude,
  disabled,
  notice,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  exclude: string[];
  disabled?: boolean;
  /** Shown above the list (a refusal from the last pick). */
  notice?: ReactNode;
  onPick: (conversation: DeskConversation) => void;
}>) {
  const t = getTranslations('helpdesk').ticketLinks;
  const [query, setQuery] = useState('');
  const { data, isFetching } = useDeskConversationSearch(query, open);
  const results = (data ?? []).filter((conversation) => !exclude.includes(conversation.id));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery('');
      }}
    >
      <DialogContent className="sm:max-w-lg p-0 gap-0" data-testid="desk-ticket-picker">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {notice && <div className="px-4 pb-2">{notice}</div>}
        <Command shouldFilter={false} className="border-t">
          <CommandInput placeholder={t.searchPlaceholder} value={query} onValueChange={setQuery} maxLength={200} />
          <CommandList className="max-h-72">
            {isFetching && results.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <InlineSpinner />
                {t.searching}
              </div>
            ) : (
              <CommandEmpty>{t.noResults}</CommandEmpty>
            )}
            {results.map((conversation) => (
              <CommandItem
                key={conversation.id}
                value={conversation.id}
                disabled={disabled}
                onSelect={() => onPick(conversation)}
                className="flex items-center gap-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{ticketLabel(conversation)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{customerLabel(conversation)}</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    conversation.state === 'open' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                  )}
                >
                  {conversation.state === 'open' ? t.stateOpen : t.stateClosed}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
