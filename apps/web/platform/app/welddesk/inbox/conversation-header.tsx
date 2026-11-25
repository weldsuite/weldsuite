import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronLeft, Loader2, UserCheck, UserMinus, UserPlus } from 'lucide-react';
import { useUser } from '@/lib/auth';
import { useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { HeaderIconButton } from '@weldsuite/ui/components/header-icon-button';
import { CloseDoneButtons } from '@weldsuite/ui/components/close-done-buttons';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useManageDeskConversation, type DeskConversation, type DeskMessage } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';
import { DeskSlaBadge } from './sla-badge';
import { TranslateLanguageBadge } from './translation/translate-toggle';
import { ConversationLinkMenu } from './conversation-link-menu';
import { CreateTicketAction } from './create-ticket-action';
import { DeskCallButton } from '@/components/welddesk/phone/desk-call-button';

interface ConversationHeaderProps {
  conversation: DeskConversation;
  /** The loaded timeline; the call button reads the caller's number from it. */
  messages?: readonly DeskMessage[];
  liveCall?: boolean;
  /** The visitor currently has the widget open on this conversation. */
  visitorOnline?: boolean;
}

export function ConversationHeader({ conversation, messages, liveCall = false, visitorOnline = false }: Readonly<ConversationHeaderProps>) {
  const t = getTranslations('deskInbox2');
  const router = useRouter();
  const { user } = useUser();
  const manage = useManageDeskConversation();
  const { data: membersData } = useDeskWorkspaceMembers();
  const members = membersData ?? [];
  const assignedMember = members.find((m) => m.userId === conversation.assigneeId);
  const isClosed = conversation.state === 'closed';
  const [assignOpen, setAssignOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    setQuery('');
  }, [conversation.id]);

  const toggleClose = async () => {
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: isClosed ? 'open' : 'close' } });
      toast.success(isClosed ? t.header.reopenSuccess : t.header.closeSuccess);
    } catch {
      toast.error(t.header.manageError);
    }
  };

  const assign = async (assigneeId: string | null) => {
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: 'assign', assigneeId } });
      toast.success(t.header.assignSuccess);
      setAssignOpen(false);
    } catch {
      toast.error(t.header.assignError);
    }
  };

  const filteredMembers = members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()));
  const displayTitle = conversation.title ?? conversation.name ?? conversation.email ?? t.pane.untitled;

  // The header is a container: the thread column's width, not the window's,
  // decides whether the actions show their labels. Between the list and the
  // details panel the column is narrow on a laptop, and labelled actions ran
  // under the panel there (`@3xl/desk-header:` in the actions below).
  return (
    <div className="@container/desk-header flex items-center justify-between gap-2 px-3 md:px-4 h-[53px] border-b border-gray-200 dark:border-border flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden p-1.5 -ml-1 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors flex-shrink-0"
          onClick={() => router.push('/welddesk/inbox')}
          aria-label={t.header.backToList}
        >
          <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-muted-foreground" />
        </Button>
        <CloseDoneButtons
          className="hidden md:flex"
          onClose={() => router.push('/welddesk/inbox')}
          closeLabel={t.header.backToList}
          onDone={() => void toggleClose()}
          doneLabel={isClosed ? t.header.reopen : t.header.close}
          doneDisabled={manage.isPending}
        />
        <h1 className="text-sm md:text-lg font-semibold text-gray-900 dark:text-foreground md:ml-2 truncate">
          {displayTitle}
        </h1>
        <DeskSlaBadge conversation={conversation} />
        {visitorOnline && (
          <span
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 flex-shrink-0"
            data-testid="desk-inbox-visitor-online"
          >
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {t.pane.online}
          </span>
        )}
        {liveCall && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 flex-shrink-0">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            {t.header.liveCall}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
        <DeskCallButton conversation={conversation} messages={messages} />
        <TranslateLanguageBadge conversation={conversation} />
        <CreateTicketAction conversation={conversation} />
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            {/* The assignee's avatar once someone has it, otherwise the assign icon. */}
            <HeaderIconButton label={assignedMember?.name ?? t.header.assign}>
              {assignedMember ? (
                <Avatar className="h-4 w-4">
                  {assignedMember.picture && <AvatarImage src={assignedMember.picture} />}
                  <AvatarFallback className="text-[9px]">{assignedMember.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
              ) : (
                <UserPlus />
              )}
            </HeaderIconButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-0">
            <Command shouldFilter={false}>
              <CommandInput placeholder={t.header.assignSearchPlaceholder} value={query} onValueChange={setQuery} />
              <CommandList className="max-h-64">
                <CommandEmpty>{t.header.assignNoMembers}</CommandEmpty>
                {/* "Assign to me" lives in this menu: one Assign button, me first. */}
                {user?.id && conversation.assigneeId !== user.id && !query && (
                  <CommandItem value="__assign_to_me__" onSelect={() => void assign(user.id)} disabled={manage.isPending}>
                    <UserCheck className="h-3.5 w-3.5" />
                    <span className="truncate flex-1">{t.header.assignToMe}</span>
                  </CommandItem>
                )}
                {filteredMembers.map((member) => (
                  <CommandItem key={member.userId} value={member.userId} onSelect={() => void assign(member.userId)}>
                    <Avatar className="h-5 w-5">
                      {member.picture && <AvatarImage src={member.picture} />}
                      <AvatarFallback className="text-[10px]">{member.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate flex-1">{member.name}</span>
                    {member.userId === conversation.assigneeId && <Check className="h-3.5 w-3.5 text-primary" />}
                  </CommandItem>
                ))}
                {conversation.assigneeId && (
                  <CommandItem
                    value="__unassign__"
                    onSelect={() => void assign(null)}
                    className="text-destructive data-[selected=true]:text-destructive"
                  >
                    <UserMinus className="h-3.5 w-3.5" />
                    {t.header.assignUnassign}
                  </CommandItem>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          variant={isClosed ? 'outline' : 'default'}
          size="sm"
          className="h-8 md:hidden"
          onClick={() => void toggleClose()}
          disabled={manage.isPending}
        >
          {manage.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          {isClosed ? t.header.reopen : t.header.close}
        </Button>
        <ConversationLinkMenu conversation={conversation} />
      </div>
    </div>
  );
}
