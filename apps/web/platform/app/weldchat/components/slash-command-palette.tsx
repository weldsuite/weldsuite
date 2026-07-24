import { useMemo, type ComponentType } from 'react';
import { Smile, Bell, Volume2, VolumeX, MessageSquare, Bot, UserPlus, ListTodo } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';

interface SlashCommand {
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

interface SlashCommandPaletteProps {
  query: string;
  channelId?: string;
  /** Called when the user picks a plain command — completes text in the editor. */
  onSelect: (command: string) => void;
  /** Called when the user picks an agent from the /invite sub-picker. */
  onInviteAgent?: (agent: { id: string; name: string }) => void;
}

function parseInviteQuery(query: string): { isInvite: boolean; filter: string } {
  // query is the text from the editor starting with "/". e.g. "/invite", "/invite weld"
  if (query === '/invite') return { isInvite: true, filter: '' };
  if (query.startsWith('/invite ')) return { isInvite: true, filter: query.slice('/invite '.length) };
  return { isInvite: false, filter: '' };
}

export function SlashCommandPalette({
  query,
  channelId,
  onSelect,
  onInviteAgent,
}: SlashCommandPaletteProps) {
  const { t } = useI18n();
  const { isInvite, filter } = parseInviteQuery(query);

  const COMMANDS: SlashCommand[] = useMemo(() => [
    { name: '/createtask', description: t.weldchat.slashCommandPalette.commands.createtask, icon: ListTodo },
    { name: '/invite', description: t.weldchat.slashCommandPalette.commands.invite, icon: UserPlus },
    { name: '/giphy', description: t.weldchat.slashCommandPalette.commands.giphy, icon: Smile },
    { name: '/remind', description: t.weldchat.slashCommandPalette.commands.remind, icon: Bell },
    { name: '/status', description: t.weldchat.slashCommandPalette.commands.status, icon: MessageSquare },
    { name: '/mute', description: t.weldchat.slashCommandPalette.commands.mute, icon: VolumeX },
    { name: '/unmute', description: t.weldchat.slashCommandPalette.commands.unmute, icon: Volume2 },
    { name: '/topic', description: t.weldchat.slashCommandPalette.commands.topic, icon: MessageSquare },
    { name: '/ask', description: t.weldchat.slashCommandPalette.commands.ask, icon: Bot },
  ], [t]);

  // Agent-picker mode (only used when `/invite...` is active)
  const { data: agents = [] } = useAgents();
  const { data: membersData } = useChannelMembers(isInvite && channelId ? channelId : '');
  const existingIds = useMemo(
    () => new Set((membersData?.data ?? []).map((m) => m.userId)),
    [membersData],
  );

  const inviteableAgents = useMemo(() => {
    if (!isInvite) return [];
    const base = agents.filter((a) => !existingIds.has(a.id));
    if (!filter) return base.slice(0, 8);
    const q = filter.toLowerCase();
    return base
      .filter(
        (a) =>
          a.name?.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [isInvite, agents, existingIds, filter]);

  // Command-picker mode
  const filteredCommands = useMemo(() => {
    if (isInvite) return [];
    if (!query) return COMMANDS;
    const q = query.toLowerCase();
    return COMMANDS.filter((cmd) => cmd.name.toLowerCase().includes(q));
  }, [query, isInvite, COMMANDS]);

  if (isInvite) {
    if (!onInviteAgent) return null;
    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-lg max-h-56 overflow-y-auto z-50">
        <div className="px-3 py-1.5 border-b bg-muted/40">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            {t.weldchat.slashCommandPalette.inviteAgentToChannel}
          </p>
        </div>
        {inviteableAgents.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6 px-3">
            {filter
              ? t.weldchat.slashCommandPalette.noMatchingAgents
              : agents.length === 0
                ? t.weldchat.slashCommandPalette.noAgentsYet
                : t.weldchat.slashCommandPalette.allAgentsInChannel}
          </p>
        ) : (
          inviteableAgents.map((a) => (
            <Button
              key={a.id}
              variant="ghost"
              className="flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-muted text-left"
              onMouseDown={(e) => {
                e.preventDefault();
                onInviteAgent({ id: a.id, name: a.name });
              }}
            >
              <div className="h-6 w-6 rounded-md bg-muted flex items-center justify-center text-sm">
                {a.icon || <Bot className="h-3.5 w-3.5 text-muted-foreground" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{a.name}</div>
                {a.description && (
                  <div className="text-xs text-muted-foreground truncate">{a.description}</div>
                )}
              </div>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {a.status || 'draft'}
              </span>
            </Button>
          ))
        )}
      </div>
    );
  }

  if (filteredCommands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
      {filteredCommands.map((cmd) => (
        <Button
          key={cmd.name}
          variant="ghost"
          className="flex items-center gap-3 w-full px-3 py-2 text-sm hover:bg-muted text-left"
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd.name + ' ');
          }}
        >
          <cmd.icon className="h-4 w-4 text-muted-foreground" />
          <div>
            <span className="font-mono font-medium">{cmd.name}</span>
            <span className="text-muted-foreground ml-2">{cmd.description}</span>
          </div>
        </Button>
      ))}
    </div>
  );
}
