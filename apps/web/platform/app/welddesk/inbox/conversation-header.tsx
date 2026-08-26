import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Loader2, UserMinus, UserPlus } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { getTranslations } from '@/lib/i18n';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { useManageDeskConversation, type DeskConversation } from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';

interface ConversationHeaderProps {
  conversation: DeskConversation;
}

export function ConversationHeader({ conversation }: ConversationHeaderProps) {
  const t = getTranslations('deskInbox2');
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

  return (
    <div className="border-b px-4 py-2.5 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">
            #{conversation.conversationNumber} {displayTitle}
          </p>
          {conversation.email && (
            <p className="text-xs text-muted-foreground truncate">{conversation.email}</p>
          )}
        </div>
        <Badge variant="outline" className="text-[11px] shrink-0">
          {conversation.state}
        </Badge>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {user?.id && conversation.assigneeId !== user.id && (
          <Button variant="outline" size="sm" className="h-8" onClick={() => assign(user.id)} disabled={manage.isPending}>
            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
            {t.header.assign}
          </Button>
        )}
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5 h-8">
              {assignedMember ? (
                <>
                  <Avatar className="h-4 w-4">
                    {assignedMember.picture && <AvatarImage src={assignedMember.picture} />}
                    <AvatarFallback className="text-[9px]">{assignedMember.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-[100px] truncate">{assignedMember.name}</span>
                </>
              ) : (
                t.header.assign
              )}
              <ChevronDown className="h-3 w-3 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-0">
            <Command shouldFilter={false}>
              <CommandInput placeholder={t.header.assignSearchPlaceholder} value={query} onValueChange={setQuery} />
              <CommandList className="max-h-64">
                <CommandEmpty>{t.header.assignNoMembers}</CommandEmpty>
                {filteredMembers.map((member) => (
                  <CommandItem key={member.userId} value={member.userId} onSelect={() => assign(member.userId)}>
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
                    onSelect={() => assign(null)}
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
          className="h-8"
          onClick={toggleClose}
          disabled={manage.isPending}
        >
          {manage.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
          {isClosed ? t.header.reopen : t.header.close}
        </Button>
      </div>
    </div>
  );
}
