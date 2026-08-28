import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronLeft, Loader2, UserMinus, UserPlus, X } from 'lucide-react';
import { useUser } from '@clerk/clerk-react';
import { useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
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

  return (
    <div className="flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-gray-200 dark:border-border flex-shrink-0">
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
        <div className="hidden md:flex items-center border border-border rounded-md overflow-hidden">
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
            onClick={() => router.push('/welddesk/inbox')}
            aria-label={t.header.backToList}
          >
            <X className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
          </Button>
          <div className="w-px h-5 bg-border" />
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
            onClick={() => void toggleClose()}
            disabled={manage.isPending}
            title={isClosed ? t.header.reopen : t.header.close}
          >
            <Check className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
          </Button>
        </div>
        <h1 className="text-sm md:text-lg font-semibold text-gray-900 dark:text-foreground md:ml-2 truncate">
          {displayTitle}
        </h1>
        {conversation.email && (
          <span className="hidden md:inline text-sm text-gray-500 dark:text-muted-foreground truncate">
            {conversation.email}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
        {user?.id && conversation.assigneeId !== user.id && (
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:flex h-8 px-2 text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
            onClick={() => void assign(user.id)}
            disabled={manage.isPending}
          >
            <UserPlus className="h-4 w-4 mr-1.5" />
            {t.header.assign}
          </Button>
        )}
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1.5 text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary"
            >
              {assignedMember ? (
                <>
                  <Avatar className="h-4 w-4">
                    {assignedMember.picture && <AvatarImage src={assignedMember.picture} />}
                    <AvatarFallback className="text-[9px]">{assignedMember.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:inline max-w-[100px] truncate">{assignedMember.name}</span>
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  <span className="hidden sm:inline">{t.header.assign}</span>
                </>
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
      </div>
    </div>
  );
}
