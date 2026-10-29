/**
 * Bring a workspace agent into a channel.
 *
 * Lists the agents the viewer may use that are not in the channel yet.
 * Once in, an agent answers when someone @mentions it there, working in the
 * background and replying in the chat. Anyone in the channel with
 * `weldagent:use` may invite one (the agent acts with the asker's permissions),
 * so this is offered next to, not instead of, the moderator-only "add people".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { useCan } from '@weldsuite/permissions/react';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useChannel, useChannelMembers, useInviteChannelAgents } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';

/** Channel types agents can join (record chats included); DMs stay between people. */
const AGENT_ROOM_TYPES = new Set(['public', 'private', 'entity']);

/** Whether the viewer can bring agents into (and out of) this channel. */
export function useCanInviteAgents(channelId: string | undefined): boolean {
  const canUseAgents = useCan('weldagent:use');
  const { data } = useChannel(channelId || '');
  return canUseAgents && !!channelId && AGENT_ROOM_TYPES.has(data?.data?.type ?? '');
}

/**
 * Agents the viewer may use that are not in the channel yet, whatever their
 * status: a draft or paused agent still answers when tagged, as in its own chat
 * (pausing only stops routines and event triggers).
 */
export function useInvitableAgents(channelId: string | undefined, enabled: boolean): WorkspaceAgent[] {
  const { data: agents } = useAgents(undefined, enabled);
  const { data: membersData } = useChannelMembers(channelId || '');
  return useMemo(() => {
    if (!enabled) return [];
    const inChannel = new Set((membersData?.data ?? []).map((m) => m.userId));
    return (agents ?? []).filter((a) => !inChannel.has(a.id));
  }, [agents, membersData, enabled]);
}

/** Invite one agent, with a toast either way. Resolves to whether it joined. */
export function useInviteAgent(channelId: string): (agent: Pick<WorkspaceAgent, 'id' | 'name'>) => Promise<boolean> {
  const { t } = useI18n();
  const { mutateAsync } = useInviteChannelAgents();
  return useCallback(
    async (agent) => {
      try {
        await mutateAsync({ channelId, agentIds: [agent.id] });
        toast.success(t.weldchat.memberList.agentAdded.replace('{name}', agent.name));
        return true;
      } catch {
        toast.error(t.weldchat.memberList.addAgentFailed.replace('{name}', agent.name));
        return false;
      }
    },
    [channelId, mutateAsync, t],
  );
}

interface InviteAgentPickerProps {
  channelId: string;
  onClose: () => void;
}

export function InviteAgentPicker({ channelId, onClose }: Readonly<InviteAgentPickerProps>) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const agents = useInvitableAgents(channelId, true);
  const inviteAgent = useInviteAgent(channelId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      const target = e.target as Element;
      // The toggle button closes the picker itself; closing here would reopen it.
      if (target.closest?.('[data-testid="invite-agent-button"]')) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [onClose]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q));
  }, [agents, search]);

  return (
    <div className="px-3 py-2 border-b" ref={ref} data-testid="invite-agent-picker">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.weldchat.memberList.searchAgents}
          className="h-8 pl-7 text-sm"
          autoFocus
        />
      </div>
      {/* A plain scroll box: Radix ScrollArea's table-layout viewport grows to the
          longest description instead of truncating it. */}
      <div className="mt-1 max-h-[200px] overflow-x-hidden overflow-y-auto">
        <div className="py-1">
          {visible.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              className="w-full h-auto flex items-center justify-start gap-2.5 px-2 py-1.5 rounded-md text-left text-sm hover:bg-accent transition-colors"
              onClick={() => {
                void inviteAgent(agent);
                setSearch('');
              }}
            >
              <span className="h-6 w-6 flex-shrink-0 rounded-[6px] bg-muted flex items-center justify-center text-[13px]">
                {agent.icon || <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block truncate">{agent.name}</span>
                {agent.description && (
                  <span className="block truncate text-[11px] text-muted-foreground font-normal">{agent.description}</span>
                )}
              </span>
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          ))}
          {visible.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-3">{t.weldchat.memberList.noAgentsToInvite}</p>
          )}
        </div>
      </div>
    </div>
  );
}
