'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { makeAgentIcon } from '../hooks/use-agents-sidebar-items';

interface AgentAvatarProps {
  agent: { id: string; name: string; icon?: string | null; status?: string };
  size?: 'sm' | 'md';
  className?: string;
}

/** The agent's icon on a tile, with a dot when it is live. */
export function AgentAvatar({ agent, size = 'md', className }: Readonly<AgentAvatarProps>) {
  const Icon = useMemo(
    () => makeAgentIcon({ id: agent.id, name: agent.name, icon: agent.icon, isSystem: false }),
    [agent.id, agent.name, agent.icon],
  );
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-xl bg-muted',
        size === 'sm' ? 'h-8 w-8' : 'h-9 w-9',
        className,
      )}
    >
      <Icon className={size === 'sm' ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
      {agent.status === 'active' && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-emerald-500" />
      )}
    </span>
  );
}
