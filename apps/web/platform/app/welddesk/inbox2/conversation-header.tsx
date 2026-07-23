import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { addDays, nextMonday, setHours, setMinutes, setSeconds, format } from 'date-fns';
import {
  Check,
  ChevronDown,
  Clock,
  Flag,
  Loader2,
  Plus,
  RotateCcw,
  Tag as TagIcon,
  Users,
  X,
} from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { TimePicker } from '@weldsuite/ui/components/time-picker';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  useAddDeskConversationTag,
  useDeskTeams,
  useManageDeskConversation,
  useRemoveDeskConversationTag,
  useUpdateDeskConversationAttributes,
  type DeskConversation,
} from '@/hooks/queries/use-desk-queries';
import { useDeskWorkspaceMembers } from '@/hooks/queries/use-desk-workspace-members';

interface ConversationHeaderProps {
  conversation: DeskConversation;
  assignPopoverOpen: boolean;
  onAssignPopoverOpenChange: (open: boolean) => void;
  snoozePopoverOpen: boolean;
  onSnoozePopoverOpenChange: (open: boolean) => void;
  /**
   * Called on every render with the header's own close/reopen handler, so
   * the Shift+C hotkey (owned by the parent ConversationPane) can invoke the
   * exact same mutation the header button uses — one source of truth for
   * the toggle instead of duplicating the mutation call site.
   */
  onToggleCloseHandlerReady: (handler: () => void) => void;
}

function computeLaterToday(): Date {
  const now = new Date();
  const target = setSeconds(setMinutes(setHours(now, 18), 0), 0);
  return target > now ? target : addDays(target, 1);
}

function computeTomorrowMorning(): Date {
  return setSeconds(setMinutes(setHours(addDays(new Date(), 1), 9), 0), 0);
}

function computeNextMondayMorning(): Date {
  return setSeconds(setMinutes(setHours(nextMonday(new Date()), 9), 0), 0);
}

function TitleEditor({ conversation }: { conversation: DeskConversation }) {
  const t = getTranslations('deskInbox2');
  const updateAttributes = useUpdateDeskConversationAttributes();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conversation.title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(conversation.title ?? '');
  }, [conversation.id, conversation.title]);

  const displayTitle = conversation.title ?? conversation.source?.subject ?? t.pane.untitled;

  if (!editing) {
    return (
      <button
        type="button"
        className="text-sm font-semibold truncate hover:underline text-left"
        onClick={() => {
          setEditing(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        #{conversation.conversationNumber} {displayTitle}
      </button>
    );
  }

  const commit = async () => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed === (conversation.title ?? '')) return;
    try {
      await updateAttributes.mutateAsync({ id: conversation.id, data: { title: trimmed || null } });
    } catch {
      toast.error(t.header.titleUpdateError);
    }
  };

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          setValue(conversation.title ?? '');
          setEditing(false);
        }
      }}
      placeholder={t.header.assignSearchPlaceholder}
      className="h-7 text-sm font-semibold"
    />
  );
}

function AssignPopover({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: DeskConversation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getTranslations('deskInbox2');
  const manage = useManageDeskConversation();
  const { data: membersData } = useDeskWorkspaceMembers();
  const { data: teamsData } = useDeskTeams();
  const [tab, setTab] = useState<'teammates' | 'teams'>('teammates');
  const [query, setQuery] = useState('');

  const members = membersData ?? [];
  const teams = teamsData?.data ?? [];

  const assignedMember = members.find((m) => m.userId === conversation.adminAssigneeId);
  const assignedTeam = teams.find((tm) => tm.id === conversation.teamAssigneeId);

  const doAssign = async (assigneeType: 'admin' | 'team', assigneeId: string | null) => {
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: 'assign', assigneeType, assigneeId } });
      toast.success(t.header.assignSuccess);
      onOpenChange(false);
    } catch {
      toast.error(t.header.assignError);
    }
  };

  const filteredMembers = members.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()));
  const filteredTeams = teams.filter((tm) => tm.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8" data-testid="desk-inbox2-assign-trigger">
          {assignedMember ? (
            <>
              <Avatar className="h-4 w-4">
                {assignedMember.picture && <AvatarImage src={assignedMember.picture} />}
                <AvatarFallback className="text-[9px]">{assignedMember.name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="max-w-[100px] truncate">{assignedMember.name}</span>
            </>
          ) : assignedTeam ? (
            <>
              <Users className="h-3.5 w-3.5" />
              <span className="max-w-[100px] truncate">{assignedTeam.name}</span>
            </>
          ) : (
            <>
              <Users className="h-3.5 w-3.5" />
              {t.header.assign}
            </>
          )}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Tabs value={tab} onValueChange={(v) => setTab(v as 'teammates' | 'teams')}>
          <div className="p-2 pb-0">
            <TabsList className="w-full">
              <TabsTrigger value="teammates" className="flex-1">
                {t.header.assignTeammates}
              </TabsTrigger>
              <TabsTrigger value="teams" className="flex-1">
                {t.header.assignTeams}
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
        <Command shouldFilter={false}>
          <CommandInput placeholder={t.header.assignSearchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-64">
            {tab === 'teammates' ? (
              <>
                <CommandEmpty>{t.header.assignNoMembers}</CommandEmpty>
                {filteredMembers.map((member) => (
                  <CommandItem key={member.userId} value={member.userId} onSelect={() => doAssign('admin', member.userId)}>
                    <Avatar className="h-5 w-5">
                      {member.picture && <AvatarImage src={member.picture} />}
                      <AvatarFallback className="text-[10px]">{member.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <span className="truncate flex-1">{member.name}</span>
                    {member.userId === conversation.adminAssigneeId && <Check className="h-3.5 w-3.5 text-primary" />}
                  </CommandItem>
                ))}
              </>
            ) : (
              <>
                <CommandEmpty>{t.header.assignNoTeams}</CommandEmpty>
                {filteredTeams.map((team) => (
                  <CommandItem key={team.id} value={team.id} onSelect={() => doAssign('team', team.id)}>
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate flex-1">{team.name}</span>
                    {team.id === conversation.teamAssigneeId && <Check className="h-3.5 w-3.5 text-primary" />}
                  </CommandItem>
                ))}
              </>
            )}
            {(conversation.adminAssigneeId || conversation.teamAssigneeId) && (
              <CommandItem
                value="__unassign__"
                onSelect={() => doAssign(tab === 'teammates' ? 'admin' : 'team', null)}
                className="text-destructive data-[selected=true]:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
                {t.header.assignUnassign}
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SnoozePopover({
  conversation,
  open,
  onOpenChange,
}: {
  conversation: DeskConversation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getTranslations('deskInbox2');
  const manage = useManageDeskConversation();
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined);
  const [customTime, setCustomTime] = useState('09:00');
  const [showCustom, setShowCustom] = useState(false);

  const isSnoozed = conversation.state === 'snoozed';

  const doSnooze = async (date: Date) => {
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: 'snooze', snoozedUntil: date.toISOString() } });
      toast.success(t.header.snoozeSuccess);
      onOpenChange(false);
      setShowCustom(false);
    } catch {
      toast.error(t.header.snoozeError);
    }
  };

  const doUnsnooze = async () => {
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: 'open' } });
      onOpenChange(false);
    } catch {
      toast.error(t.header.snoozeError);
    }
  };

  const applyCustom = () => {
    if (!customDate) return;
    const [h, m] = customTime.split(':').map(Number);
    const date = setSeconds(setMinutes(setHours(customDate, h ?? 9), m ?? 0), 0);
    doSnooze(date);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setShowCustom(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8" data-testid="desk-inbox2-snooze-trigger">
          <Clock className="h-3.5 w-3.5" />
          {t.header.snooze}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {!showCustom ? (
          <div className="flex flex-col">
            <Button variant="ghost" className="justify-between h-9 px-2" onClick={() => doSnooze(computeLaterToday())}>
              <span>{t.header.snoozeLaterToday}</span>
              <span className="text-xs text-muted-foreground">{t.header.snoozeLaterTodayTime}</span>
            </Button>
            <Button variant="ghost" className="justify-between h-9 px-2" onClick={() => doSnooze(computeTomorrowMorning())}>
              <span>{t.header.snoozeTomorrow}</span>
              <span className="text-xs text-muted-foreground">{t.header.snoozeTomorrowTime}</span>
            </Button>
            <Button variant="ghost" className="justify-between h-9 px-2" onClick={() => doSnooze(computeNextMondayMorning())}>
              <span>{t.header.snoozeNextMonday}</span>
              <span className="text-xs text-muted-foreground">{t.header.snoozeNextMondayTime}</span>
            </Button>
            <div className="h-px bg-border my-1" />
            <Button variant="ghost" className="justify-start h-9 px-2" onClick={() => setShowCustom(true)}>
              {t.header.snoozeCustom}
            </Button>
            {isSnoozed && (
              <>
                <div className="h-px bg-border my-1" />
                <Button variant="ghost" className="justify-start h-9 px-2 text-destructive" onClick={doUnsnooze}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  {t.header.unsnooze}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-1">
            <Calendar mode="single" selected={customDate} onSelect={setCustomDate} initialFocus />
            <TimePicker value={customTime} onChange={setCustomTime} />
            <Button size="sm" disabled={!customDate || manage.isPending} onClick={applyCustom}>
              {manage.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {t.header.snoozeCustomApply}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TagsPopover({ conversation }: { conversation: DeskConversation }) {
  const t = getTranslations('deskInbox2');
  const addTag = useAddDeskConversationTag();
  const removeTag = useRemoveDeskConversationTag();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const tags = conversation.tags ?? [];

  const handleAdd = async (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed)) return;
    try {
      await addTag.mutateAsync({ id: conversation.id, tag: trimmed });
      setQuery('');
    } catch {
      toast.error(t.header.tagAddError);
    }
  };

  const handleRemove = async (tag: string) => {
    try {
      await removeTag.mutateAsync({ id: conversation.id, tag });
    } catch {
      toast.error(t.header.tagRemoveError);
    }
  };

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1 text-[11px]">
          {tag}
          <button
            type="button"
            onClick={() => handleRemove(tag)}
            aria-label={t.header.tagRemoveError}
            className="rounded-full hover:bg-muted-foreground/20 p-0.5"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t.header.addTag}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder={t.header.assignSearchPlaceholder} value={query} onValueChange={setQuery} />
            <CommandList className="max-h-48">
              {query.trim() && !tags.includes(query.trim()) && (
                <CommandGroup>
                  <CommandItem value={`create-${query}`} onSelect={() => handleAdd(query)}>
                    <TagIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    {t.header.createTag.replace('{tag}', query.trim())}
                  </CommandItem>
                </CommandGroup>
              )}
              {!query.trim() && <CommandEmpty>{t.header.noTagsFound}</CommandEmpty>}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Conversation pane header: contact/title row + action bar (assign, snooze,
 * close/reopen, priority flag, tags). `assignPopoverOpen`/`snoozePopoverOpen`
 * are lifted so the A/Z keyboard shortcuts (use-inbox-hotkeys.ts) can open
 * these popovers from outside.
 */
export function ConversationHeader({
  conversation,
  assignPopoverOpen,
  onAssignPopoverOpenChange,
  snoozePopoverOpen,
  onSnoozePopoverOpenChange,
  onToggleCloseHandlerReady,
}: ConversationHeaderProps) {
  const t = getTranslations('deskInbox2');
  const manage = useManageDeskConversation();
  const updateAttributes = useUpdateDeskConversationAttributes();

  const isClosed = conversation.state === 'closed';

  const toggleClose = async () => {
    try {
      await manage.mutateAsync({ id: conversation.id, data: { action: isClosed ? 'open' : 'close' } });
      toast.success(isClosed ? t.header.reopenSuccess : t.header.closeSuccess);
    } catch {
      toast.error(t.header.manageError);
    }
  };

  onToggleCloseHandlerReady(toggleClose);

  const togglePriority = async () => {
    try {
      await updateAttributes.mutateAsync({ id: conversation.id, data: { priority: !conversation.priority } });
    } catch {
      toast.error(t.header.priorityUpdateError);
    }
  };

  return (
    <div className="border-b px-4 py-2.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <TitleEditor conversation={conversation} />
          <Badge variant="outline" className="text-[11px] shrink-0">
            {conversation.state}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-8 w-8', conversation.priority && 'text-destructive')}
                onClick={togglePriority}
                aria-label={conversation.priority ? t.header.priorityOff : t.header.priorityOn}
                data-testid="desk-inbox2-priority-toggle"
              >
                <Flag className={cn('h-4 w-4', conversation.priority && 'fill-current')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{conversation.priority ? t.header.priorityOff : t.header.priorityOn}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <AssignPopover
                  conversation={conversation}
                  open={assignPopoverOpen}
                  onOpenChange={onAssignPopoverOpenChange}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t.header.assignTooltip}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <SnoozePopover
                  conversation={conversation}
                  open={snoozePopoverOpen}
                  onOpenChange={onSnoozePopoverOpenChange}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t.header.snoozeTooltip}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isClosed ? 'outline' : 'default'}
                size="sm"
                className="h-8"
                onClick={toggleClose}
                disabled={manage.isPending}
                data-testid="desk-inbox2-close-toggle"
              >
                {manage.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                {isClosed ? t.header.reopen : t.header.close}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isClosed ? t.header.reopenTooltip : t.header.closeTooltip}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <TagsPopover conversation={conversation} />
    </div>
  );
}
