import { Fragment, useMemo, type ReactNode } from 'react';
import { useTypingSubscriber } from '@/hooks/weldchat/use-weldchat-typing';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { RoomClient } from '@weldsuite/realtime/client';
import { useI18n } from '@/lib/i18n/provider';

const isAgentId = (userId: string) => userId.startsWith('agt_');

/** A name in the strip: a shade darker than the words around it. */
const Name = ({ children }: Readonly<{ children: ReactNode }>) => (
  <span className="font-medium text-foreground/80">{children}</span>
);

/** Fills `{key}` placeholders of a translated template with the given nodes. */
function fill(template: string, values: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((part, i) =>
    // Odd parts are the placeholder names `split` captured.
    i % 2 === 1 ? <Fragment key={i}>{values[part] ?? `{${part}}`}</Fragment> : part,
  );
}

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
  const list = (items: string[]) =>
    items.map((name, i) => (
      <Fragment key={name + i}>
        {i > 0 && ', '}
        <Name>{name}</Name>
      </Fragment>
    ));
  const parts: ReactNode[][] = [];
  if (names.length === 1) {
    parts.push(fill(strings.isTyping, { name: <Name>{names[0]}</Name> }));
  } else if (names.length === 2) {
    parts.push(fill(strings.twoTyping, { name1: <Name>{names[0]}</Name>, name2: <Name>{names[1]}</Name> }));
  } else if (names.length === 3) {
    parts.push(fill(strings.multipleTyping, { names: list(names.slice(0, -1)), last: <Name>{names.at(-1)}</Name> }));
  } else if (names.length > 3) {
    parts.push([strings.manyTyping]);
  }
  if (agentNames.length === 1) {
    parts.push(fill(strings.agentWorking, { name: <Name>{agentNames[0]}</Name> }));
  } else if (agentNames.length > 1) {
    parts.push(fill(strings.agentsWorking, { names: list(agentNames) }));
  }

  return (
    <div
      // Lined up with the messages above: the dots under their avatars (the
      // row's padding, its 2px mention border and the 28px avatar column),
      // the text under their text (the same gap).
      className="bg-background flex h-6 items-center gap-2 pb-1.5 pl-[10px] pr-4 text-xs text-muted-foreground md:gap-3 md:pl-[18px]"
      style={{
        // Discord-style soft shadow above the strip — fades messages
        // sitting behind into the bg color organically. Uses oklch
        // --background directly (project theme is oklch, not hsl).
        boxShadow: '0 -6px 12px 8px var(--background), 0 -10px 18px 4px var(--background)',
      }}
    >
      <div className="flex w-7 flex-shrink-0 justify-center" aria-hidden="true">
        <span className="flex translate-y-px gap-[3px]">
          <span className="h-[5px] w-[5px] rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms] motion-reduce:animate-none" />
          <span className="h-[5px] w-[5px] rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms] motion-reduce:animate-none" />
          <span className="h-[5px] w-[5px] rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms] motion-reduce:animate-none" />
        </span>
      </div>
      <span className="truncate leading-4">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && ' · '}
            {part}
          </Fragment>
        ))}
      </span>
    </div>
  );
}
