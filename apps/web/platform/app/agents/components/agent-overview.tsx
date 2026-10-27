'use client';

import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { WeldAgentIcon } from '@/components/icons/weldagent-icon';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useRouter } from '@/lib/router';
import { AgentAvatar } from './agent-avatar';
import { agentBadge, agentNeedsSetup, type AgentBadge } from './agent-state';

/** More agents than this and the overview gets a search box. */
const SEARCH_FROM = 6;

const BADGE_TONE: Record<AgentBadge, string> = {
  active: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  paused: 'bg-muted text-muted-foreground',
  draft: 'bg-muted text-muted-foreground',
  setup: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
};

function StatusBadge({ agent }: Readonly<{ agent: WorkspaceAgent }>) {
  const t = getTranslations('common').agents;
  const kind = agentBadge(agent);
  const label = kind === 'setup' ? t.list.needsSetupPreview : t.status[kind];
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium', BADGE_TONE[kind])}>{label}</span>
  );
}

function AgentCard({ agent }: Readonly<{ agent: WorkspaceAgent }>) {
  const t = getTranslations('common').agents.list;
  const router = useRouter();
  const description = agent.description?.trim() || (agentNeedsSetup(agent) ? t.needsSetupPreview : t.readyPreview);
  return (
    <button
      type="button"
      onClick={() => router.push(`/agents/${agent.id}`)}
      className="flex min-w-0 items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AgentAvatar agent={agent} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{agent.name}</span>
          <StatusBadge agent={agent} />
        </span>
        <span className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function OverviewSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-xl border p-4">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface AgentOverviewProps {
  agents: WorkspaceAgent[];
  loading: boolean;
  creating: boolean;
  /** Whether the person may create agents (weldagent:create or weldagent:manage). */
  canCreate: boolean;
  onCreate: () => void;
}

/** /agents: every agent as a card, with the way to start a new one. */
export function AgentOverview({ agents, loading, creating, canCreate, onCreate }: Readonly<AgentOverviewProps>) {
  const t = getTranslations('common').agents;
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q));
  }, [agents, search]);

  if (!loading && agents.length === 0) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
          <WeldAgentIcon className="h-6 w-6" />
        </span>
        <h3 className="text-lg font-semibold">{t.list.emptyTitle}</h3>
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t.list.emptyDescription}</p>
        {canCreate && (
          <Button className="mt-2 gap-1.5" disabled={creating} onClick={onCreate}>
            <Plus className="h-4 w-4" />
            {t.list.emptyAction}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{t.pageTitle}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t.list.overviewHint}</p>
          </div>
          {canCreate && (
            <Button size="sm" className="gap-1.5" disabled={creating} onClick={onCreate}>
              <Plus className="h-4 w-4" />
              {t.list.createAgent}
            </Button>
          )}
        </div>

        {agents.length >= SEARCH_FROM && (
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-9 w-full rounded-lg border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/25"
              placeholder={t.list.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}

        {loading && <OverviewSkeleton />}
        {!loading && filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">{t.list.noResultsTitle}</p>
        )}
        {!loading && filtered.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
