import { useMemo, useState } from 'react';
import { Bot, Check, ChevronDown, UserPlus, Users, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { useAgents, type Agent } from '@/hooks/queries/use-agent-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  useAddChannelMembers,
  useChannel,
  useChannelMembers,
  useWorkspaceMembers,
} from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface InvitePeopleDialogProps {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getAgentStatusConfig(
  st: (path: string) => string,
): Record<string, { label: string; color: string; bg: string }> {
  return {
    active: { label: st('sweep.entities.agentStatusActive'), color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
    paused: { label: st('sweep.entities.agentStatusPaused'), color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
    draft: { label: st('sweep.entities.agentStatusDraft'), color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  };
}

type Tab = 'members' | 'agents' | 'guest';

/** `Agent` rows returned to the UI don't model `picture` — read defensively. */
type AgentRow = Agent & { picture?: string | null };

function extractErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const inner = (err as { error?: unknown }).error;
    if (typeof inner === 'object' && inner !== null && 'message' in inner) {
      const msg = (inner as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
    }
  }
  return undefined;
}

export function InvitePeopleDialog({ channelId, open, onOpenChange }: InvitePeopleDialogProps) {
  const st = useTranslations();
  const { data: channelData } = useChannel(channelId);
  const channel = channelData?.data;
  const isPrivate = channel?.type === 'private';
  const canInviteExternal = useCan('team:invite_external');

  // Public channels don't expose the "Members" tab — everyone in the
  // workspace can already join. Default to the first available tab.
  const initialTab: Tab = isPrivate ? 'members' : 'agents';
  const [tab, setTab] = useState<Tab>(initialTab);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) setTab(initialTab);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            {st('sweep.entities.invitePeople')}
          </DialogTitle>
          <DialogDescription>
            {st('sweep.entities.invitePeopleDescription')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-3">
          <TabsList className="w-full h-9 bg-muted/60">
            {isPrivate && (
              <TabsTrigger value="members" className="gap-1.5">
                <Users className="h-3.5 w-3.5" />
                {st('sweep.entities.membersLabel')}
              </TabsTrigger>
            )}
            <TabsTrigger value="agents" className="gap-1.5">
              <Bot className="h-3.5 w-3.5" />
              {st('sweep.entities.agentsLabel')}
            </TabsTrigger>
            {canInviteExternal && (
              <TabsTrigger value="guest" className="gap-1.5">
                <UserPlus className="h-3.5 w-3.5" />
                {st('sweep.entities.guestLabel')}
              </TabsTrigger>
            )}
          </TabsList>

          {isPrivate && (
            <TabsContent value="members" className="mt-0">
              <MembersTab channelId={channelId} onDone={() => handleOpenChange(false)} />
            </TabsContent>
          )}
          <TabsContent value="agents" className="mt-0">
            <AgentsTab channelId={channelId} onDone={() => handleOpenChange(false)} />
          </TabsContent>
          {canInviteExternal && (
            <TabsContent value="guest" className="mt-0">
              <GuestTab channelId={channelId} onDone={() => handleOpenChange(false)} />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Members tab — add existing workspace people ───────────────────────────

function MembersTab({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const st = useTranslations();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: membersData } = useChannelMembers(channelId);
  const { data: workspaceData, isLoading } = useWorkspaceMembers();
  const { mutate: addMembers, isPending } = useAddChannelMembers();

  const existingIds = useMemo(
    () => new Set((membersData?.data ?? []).map((m) => m.userId)),
    [membersData],
  );
  const inviteable = useMemo(
    () => (workspaceData?.data ?? []).filter((m) => !existingIds.has(m.userId)),
    [workspaceData, existingIds],
  );
  const selectedRows = useMemo(
    () => (workspaceData?.data ?? []).filter((m) => selected.has(m.userId)),
    [workspaceData, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleInvite = () => {
    if (selected.size === 0) return;
    addMembers(
      { channelId, userIds: [...selected] },
      {
        onSuccess: () => {
          setSelected(new Set());
          onDone();
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="w-full justify-between font-normal"
          >
            <span className={selected.size === 0 ? 'text-muted-foreground' : ''}>
              {selected.size === 0
                ? st('sweep.entities.selectPeople')
                : st(
                    selected.size === 1
                      ? 'sweep.entities.peopleSelectedSingular'
                      : 'sweep.entities.peopleSelectedPlural',
                    { count: selected.size },
                  )}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
          <Command>
            <CommandInput placeholder={st('sweep.entities.searchPeoplePlaceholder')} />
            <CommandList className="max-h-[280px]">
              <CommandEmpty>
                {isLoading
                  ? st('sweep.entities.loadingEllipsis')
                  : inviteable.length === 0
                    ? st('sweep.entities.everyoneAlreadyInChannel')
                    : st('sweep.entities.noMatch')}
              </CommandEmpty>
              {inviteable.map((m) => {
                const isSelected = selected.has(m.userId);
                return (
                  <CommandItem
                    key={m.userId}
                    value={`${m.name ?? ''} ${m.email ?? ''}`}
                    onSelect={() => toggle(m.userId)}
                    className="flex items-center gap-2.5 py-2.5"
                  >
                    <Avatar className="h-7 w-7 shrink-0 !rounded-[10px]">
                      {m.picture && <AvatarImage src={m.picture} className="!rounded-[10px]" />}
                      <AvatarFallback className="text-[9px] !rounded-[10px]">
                        {(m.name || m.email || '?')[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{m.name || m.email}</div>
                      {m.name && m.email && (
                        <p className="text-[11px] text-muted-foreground truncate">{m.email}</p>
                      )}
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedRows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedRows.map((m) => (
            <Badge key={m.userId} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
              <span className="text-xs">{m.name || m.email}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => toggle(m.userId)}
                className="rounded-sm hover:bg-muted-foreground/10 p-0.5"
                aria-label={st('sweep.entities.removeNamed', { name: m.name || m.email })}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={isPending}>
          {st('sweep.entities.cancel')}
        </Button>
        <Button onClick={handleInvite} disabled={selected.size === 0 || isPending}>
          {isPending ? st('sweep.entities.adding') : `${st('sweep.entities.add')} ${selected.size || ''}`.trim()}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── Agents tab — add AI agents ────────────────────────────────────────────

function AgentsTab({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t } = useI18n();
  const st = useTranslations();
  const agentStatusConfig = useMemo(() => getAgentStatusConfig(st), [st]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { data: agents = [], isLoading } = useAgents();
  const { data: membersData } = useChannelMembers(channelId);
  const { mutate: addMembers, isPending } = useAddChannelMembers();

  const existingIds = useMemo(
    () => new Set((membersData?.data ?? []).map((m) => m.userId)),
    [membersData],
  );
  const inviteable = useMemo(
    () => (agents as AgentRow[]).filter((a) => !existingIds.has(a.id)),
    [agents, existingIds],
  );
  const selectedAgents = useMemo(
    () => (agents as AgentRow[]).filter((a) => selected.has(a.id)),
    [agents, selected],
  );
  const ts = t.weldchat?.inviteAgent;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleInvite = () => {
    if (selected.size === 0) return;
    addMembers(
      { channelId, userIds: [...selected], memberType: 'agent' },
      {
        onSuccess: () => {
          setSelected(new Set());
          onDone();
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
            <span className={selected.size === 0 ? 'text-muted-foreground' : ''}>
              {selected.size === 0
                ? (ts?.selectAgents ?? 'Select agents')
                : `${selected.size} ${selected.size === 1 ? (ts?.agentsSelected ?? 'agent selected') : (ts?.agentsSelectedPlural ?? 'agents selected')}`}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
          <Command>
            <CommandInput placeholder={ts?.searchAgents ?? 'Search agents…'} />
            <CommandList className="max-h-[280px]">
              <CommandEmpty>
                {isLoading
                  ? (ts?.loading ?? 'Loading…')
                  : agents.length === 0
                    ? (ts?.noAgents ?? 'No agents yet')
                    : inviteable.length === 0
                      ? (ts?.allInChannel ?? 'Every agent is already in this channel')
                      : (ts?.noMatch ?? 'No match')}
              </CommandEmpty>
              {inviteable.map((a) => {
                const isSelected = selected.has(a.id);
                const status = agentStatusConfig[a.status] || agentStatusConfig.draft;
                return (
                  <CommandItem
                    key={a.id}
                    value={`${a.name ?? ''} ${a.description ?? ''}`}
                    onSelect={() => toggle(a.id)}
                    className="flex items-center gap-2.5 py-2.5"
                  >
                    <Avatar className="h-7 w-7 shrink-0 !rounded-[10px]">
                      {a.picture && <AvatarImage src={a.picture} className="!rounded-[10px]" />}
                      <AvatarFallback className="text-[9px] !rounded-[10px]">
                        {a.icon || (a.name?.[0] ?? '?').toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{a.name}</span>
                        <span
                          className={cn(
                            'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none shrink-0',
                            status.color,
                            status.bg,
                          )}
                        >
                          {status.label}
                        </span>
                      </div>
                      {a.description && (
                        <p className="text-[11px] text-muted-foreground truncate">{a.description}</p>
                      )}
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedAgents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedAgents.map((a) => (
            <Badge key={a.id} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
              <span className="text-xs">{a.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => toggle(a.id)}
                className="rounded-sm hover:bg-muted-foreground/10 p-0.5"
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={isPending}>
          {ts?.cancel ?? 'Cancel'}
        </Button>
        <Button onClick={handleInvite} disabled={selected.size === 0 || isPending}>
          {isPending
            ? (ts?.inviting ?? 'Inviting…')
            : selected.size === 0
              ? (ts?.selectToInvite ?? 'Select to invite')
              : `${ts?.invite ?? 'Invite'} ${selected.size}`}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── Guest tab — invite by email ───────────────────────────────────────────

interface InviteResponse {
  data?: {
    memberId: string;
    memberType: 'INTERNAL' | 'EXTERNAL_GUEST';
    activated: boolean;
  };
}

function GuestTab({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t } = useI18n();
  const ts = t.weldchat?.inviteExternal;
  const { getClient } = useAppApiClient();
  const { mutateAsync: addMembers } = useAddChannelMembers();
  const qc = useQueryClient();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name) return;
    setError(null);
    setSubmitting(true);
    try {
      const client = await getClient();
      const res = await client.post<InviteResponse>('/team-members/invite', {
        email: email.trim(),
        name: name.trim(),
        memberType: 'EXTERNAL_GUEST',
      });
      const data = res?.data;
      if (!data) throw new Error('Empty response');
      if (data.activated) {
        await addMembers({ channelId, userIds: [data.memberId] });
        await qc.invalidateQueries({ queryKey: ['installed-apps'] });
        toast.success(`${name.trim()} added to the channel`);
      } else {
        toast.success(
          ts?.pending ?? "Invitation sent. They'll join the channel automatically once they accept.",
        );
      }
      setEmail('');
      setName('');
      onDone();
    } catch (err) {
      const msg = extractErrorMessage(err) || ts?.genericError || 'Failed to send invitation';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {ts?.description ?? "Add a client, freelancer, vendor, or partner to this channel. Guests only see the channels you invite them to and don't use a paid seat."}
      </p>
      <div className="space-y-2">
        <Label htmlFor="invite-people-name">{ts?.nameLabel ?? 'Name'}</Label>
        <Input
          id="invite-people-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={ts?.namePlaceholder ?? 'Jane Doe'}
          autoFocus
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-people-email">{ts?.emailLabel ?? 'Email'}</Label>
        <Input
          id="invite-people-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={ts?.emailPlaceholder ?? 'jane@example.com'}
          required
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={submitting}>
          {ts?.cancel ?? 'Cancel'}
        </Button>
        <Button type="submit" disabled={submitting || !email || !name}>
          {submitting ? (ts?.submitting ?? 'Sending…') : (ts?.submit ?? 'Send invitation')}
        </Button>
      </DialogFooter>
    </form>
  );
}
