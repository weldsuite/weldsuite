import { useMemo, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useAgents, type Agent } from '@/hooks/queries/use-agent-queries';
import {
  useAddChannelMembers,
  useChannelMembers,
} from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface InviteAgentDialogProps {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Agent row as rendered by the invite picker. `picture` isn't on the shared
 * `Agent` type (agents don't have avatar uploads yet), but the UI already
 * accounts for one landing later — falls back to `icon`/initials either way.
 */
interface InviteableAgent extends Agent {
  picture?: string;
}

// Mirrors the status pill design in apps/web/platform/app/agents/page.tsx so the
// agent labels here read the same as the agents list.
const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  active: {
    label: 'Active',
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950',
  },
  paused: {
    label: 'Paused',
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950',
  },
  draft: {
    label: 'Draft',
    color: 'text-gray-600 dark:text-muted-foreground',
    bg: 'bg-gray-100 dark:bg-secondary',
  },
};

export function InviteAgentDialog({ channelId, open, onOpenChange }: InviteAgentDialogProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const statusLabels: Record<string, string> = {
    active: st('sweep.weldchat.inviteAgent.statusActive'),
    paused: st('sweep.weldchat.inviteAgent.statusPaused'),
    draft: st('sweep.weldchat.inviteAgent.statusDraft'),
  };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: agentsData = [], isLoading } = useAgents();
  const agents = agentsData as InviteableAgent[];
  const { data: membersData } = useChannelMembers(channelId);
  const { mutate: addMembers, isPending } = useAddChannelMembers();

  const existingMemberIds = useMemo(
    () => new Set((membersData?.data ?? []).map((m) => m.userId)),
    [membersData],
  );

  // cmdk's CommandInput handles fuzzy search internally, so we just supply
  // the full list of agents that aren't already in the channel.
  const inviteable = useMemo(
    () => agents.filter((a) => !existingMemberIds.has(a.id)),
    [agents, existingMemberIds],
  );

  const selectedAgents = useMemo(
    () => agents.filter((a) => selected.has(a.id)),
    [agents, selected],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleInvite = () => {
    if (selected.size === 0) return;
    addMembers(
      { channelId, userIds: [...selected], memberType: 'agent' },
      {
        onSuccess: () => {
          setSelected(new Set());
          onOpenChange(false);
        },
      },
    );
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setSelected(new Set());
      setPickerOpen(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t.weldchat.inviteAgent.title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={pickerOpen}
                className="w-full justify-between font-normal"
              >
                <span className={selected.size === 0 ? 'text-muted-foreground' : ''}>
                  {selected.size === 0
                    ? t.weldchat.inviteAgent.selectAgents
                    : `${selected.size} ${selected.size === 1 ? t.weldchat.inviteAgent.agentsSelected : t.weldchat.inviteAgent.agentsSelectedPlural}`}
                </span>
                <ChevronDown className="h-4 w-4 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="p-0 w-[var(--radix-popover-trigger-width)]"
              align="start"
            >
              <Command>
                <CommandInput placeholder={t.weldchat.inviteAgent.searchAgents} />
                <CommandList className="max-h-[280px]">
                  <CommandEmpty>
                    {isLoading
                      ? t.weldchat.inviteAgent.loading
                      : agents.length === 0
                        ? t.weldchat.inviteAgent.noAgents
                        : inviteable.length === 0
                          ? t.weldchat.inviteAgent.allInChannel
                          : t.weldchat.inviteAgent.noMatch}
                  </CommandEmpty>
                  {inviteable.map((a) => {
                    const isSelected = selected.has(a.id);
                    const status = STATUS_CONFIG[a.status as string] || STATUS_CONFIG.draft;
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
                              {statusLabels[a.status as string] ?? status.label}
                            </span>
                          </div>
                          {a.description && (
                            <p className="text-[11px] text-muted-foreground truncate">
                              {a.description}
                            </p>
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
                    variant="ghost"
                    type="button"
                    onClick={() => toggle(a.id)}
                    className="rounded-sm hover:bg-muted-foreground/10 p-0.5"
                    aria-label={st('sweep.weldchat.inviteAgent.removeAgent', { name: a.name })}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
            {t.weldchat.inviteAgent.cancel}
          </Button>
          <Button onClick={handleInvite} disabled={selected.size === 0 || isPending}>
            {isPending
              ? t.weldchat.inviteAgent.inviting
              : selected.size === 0
                ? t.weldchat.inviteAgent.selectToInvite
                : `${t.weldchat.inviteAgent.invite} ${selected.size} ${selected.size === 1 ? t.weldchat.inviteAgent.agentsSelected : t.weldchat.inviteAgent.agentsSelectedPlural}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
