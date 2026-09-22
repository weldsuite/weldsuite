
import * as React from 'react';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { WeldAgentIcon } from '@/components/icons/weldagent-icon';
import { isKnownLucideIcon, LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { getTranslations } from '@/lib/i18n';
import { useCan } from '@weldsuite/permissions/react';

const AGENT_ICON_PALETTES = [
  'text-sky-600 dark:text-sky-300',
  'text-emerald-600 dark:text-emerald-300',
  'text-amber-600 dark:text-amber-300',
  'text-rose-600 dark:text-rose-300',
  'text-indigo-600 dark:text-indigo-300',
  'text-fuchsia-600 dark:text-fuchsia-300',
  'text-cyan-600 dark:text-cyan-300',
  'text-orange-600 dark:text-orange-300',
  'text-lime-700 dark:text-lime-300',
  'text-pink-600 dark:text-pink-300',
];

const SYSTEM_AGENT_ICON_PALETTE = 'text-violet-600 dark:text-violet-300';

function iconColorForAgent(agent: { id: string; name: string; isSystem: boolean }): string {
  if (agent.isSystem) return SYSTEM_AGENT_ICON_PALETTE;
  const seed = agent.id || agent.name;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AGENT_ICON_PALETTES[Math.abs(hash) % AGENT_ICON_PALETTES.length];
}

function isImageUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('/');
}

/** A glyph (emoji / ZWJ sequence), not a word like "Receipt". */
function isEmojiIcon(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16) return false;
  if (/[A-Za-z0-9]/.test(trimmed)) return false;
  return /\p{Extended_Pictographic}/u.test(trimmed);
}

export type AgentIconKind = 'empty' | 'image' | 'emoji' | 'lucide' | 'fallback';

export function classifyAgentIcon(icon: string | null | undefined): AgentIconKind {
  if (!icon || !icon.trim()) return 'empty';
  if (isImageUrl(icon)) return 'image';
  if (isEmojiIcon(icon)) return 'emoji';
  if (isKnownLucideIcon(icon)) return 'lucide';
  return 'fallback';
}

function makeAgentIcon(agent: { id: string; name: string; icon?: string | null; isSystem: boolean }): React.ComponentType<{ className?: string }> {
  const colorClass = iconColorForAgent(agent);
  const kind = classifyAgentIcon(agent.icon);
  return function AgentIcon({ className }: { className?: string }) {
    const slot = `${className ?? ''} shrink-0`;
    if (kind === 'image' && agent.icon) {
      return (
        <img
          src={agent.icon}
          alt=""
          className={`${slot} rounded-sm object-cover`}
        />
      );
    }
    if (kind === 'emoji' && agent.icon) {
      return (
        <span className={`${slot} inline-flex items-center justify-center overflow-hidden text-sm leading-none ${colorClass}`}>
          {agent.icon}
        </span>
      );
    }
    if (kind === 'lucide' && agent.icon && !agent.isSystem) {
      return (
        <LucideDynamicIcon
          name={agent.icon}
          className={`${slot} ${colorClass}`}
          fallback={() => <WeldAgentIcon className={`${slot} ${colorClass}`} />}
        />
      );
    }
    return <WeldAgentIcon className={`${slot} ${colorClass}`} />;
  };
}

export function useAgentsSidebarItems(isActive: boolean): {
  menuGroups: MenuGroupProps[];
} {
  const t = getTranslations('common');
  const canReadAgents = useCan('weldagent:read');
  // Only fetch when the agents module sidebar is active and the user can
  // read agents — UnifiedModuleSidebar mounts every module hook on every
  // page, and /weldagent/agents requires weldagent:read.
  const { data: agents = [] } = useAgents(undefined, isActive && canReadAgents);

  if (!isActive) {
    return { menuGroups: [] };
  }

  const generalItems: MenuItemProps[] = [
    { title: t.agents.sidebar.allAgents, href: '/agents', icon: WeldAgentIcon },
  ];

  const agentItems: MenuItemProps[] = agents.map((agent) => ({
    title: agent.name,
    href: `/agents/${agent.id}`,
    icon: makeAgentIcon({ ...agent, isSystem: false }),
  }));

  const menuGroups: MenuGroupProps[] = [
    {
      group: t.agents.sidebar.groupGeneral,
      items: generalItems,
    },
  ];

  if (agentItems.length > 0) {
    menuGroups.push({
      group: t.agents.sidebar.groupAgents,
      items: agentItems,
    });
  }

  return { menuGroups };
}
