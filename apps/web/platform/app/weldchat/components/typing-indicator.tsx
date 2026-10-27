import { useMemo } from 'react';
import { useTypingSubscriber } from '@/hooks/weldchat/use-weldchat-typing';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { RoomClient } from '@weldsuite/realtime/client';
import { useI18n } from '@/lib/i18n/provider';

const isAgentId = (userId: string) => userId.startsWith('agt_');

interface TypingIndicatorProps {
  channelId: string;
  client?: RoomClient | null;
}

export function TypingIndicator({ client }: Readonly<TypingIndicatorProps>) {
  const { t } = useI18n();
  const typingUsers = useTypingSubscriber(client ?? null);
  const { data: membersData } = useWorkspaceMembers();

  const memberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      const uid = m.userId || m.id;
      if (uid) map.set(uid, m.name || m.firstName || m.email || '');
    }
    return map;
  }, [membersData]);

  if (typingUsers.length === 0) return null;

  const strings = t.weldchat.typingIndicator;
  const nameOf = (u: { userId: string; userName?: string }) => memberMap.get(u.userId) || u.userName || strings.someone;
  // Agents announce a background turn on the typing channel (`agt_*` ids):
  // they are working on a reply, not typing one.
  const names = typingUsers.filter((u) => !isAgentId(u.userId)).map(nameOf);
  const agentNames = typingUsers.filter((u) => isAgentId(u.userId)).map(nameOf);
  const parts: string[] = [];
  if (names.length === 1) {
    parts.push(strings.isTyping.replace('{name}', names[0]));
  } else if (names.length === 2) {
    parts.push(strings.twoTyping.replace('{name1}', names[0]).replace('{name2}', names[1]));
  } else if (names.length === 3) {
    parts.push(strings.multipleTyping.replace('{names}', names.slice(0, -1).join(', ')).replace('{last}', names.at(-1)!));
  } else if (names.length > 3) {
    parts.push(strings.manyTyping);
  }
  if (agentNames.length === 1) {
    parts.push(strings.agentWorking.replace('{name}', agentNames[0]));
  } else if (agentNames.length > 1) {
    parts.push(strings.agentsWorking.replace('{names}', agentNames.join(', ')));
  }
  const text = parts.join(' · ');

  return (
    <div
      className="bg-background pl-[18px] pr-4 pt-[2px] pb-[8px] flex items-center gap-3 text-[12.5px] leading-none text-muted-foreground/80"
      style={{
        // Discord-style soft shadow above the strip — fades messages
        // sitting behind into the bg color organically. Uses oklch
        // --background directly (project theme is oklch, not hsl).
        boxShadow: '0 -6px 12px 8px var(--background), 0 -10px 18px 4px var(--background)',
      }}
    >
      <div className="w-7 flex justify-center flex-shrink-0">
        <span className="flex gap-[3.5px]">
          <span className="w-[4.5px] h-[4.5px] bg-muted-foreground/70 rounded-full animate-bounce [animation-delay:0ms]" />
          <span className="w-[4.5px] h-[4.5px] bg-muted-foreground/70 rounded-full animate-bounce [animation-delay:150ms]" />
          <span className="w-[4.5px] h-[4.5px] bg-muted-foreground/70 rounded-full animate-bounce [animation-delay:300ms]" />
        </span>
      </div>
      <span className="truncate">{text}</span>
    </div>
  );
}
