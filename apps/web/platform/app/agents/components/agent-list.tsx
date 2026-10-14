'use client';

import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { usePathname, useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { useAgents, useCreateAgent } from '@/hooks/queries/use-agent-queries';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { AgentAvatar } from './agent-avatar';
import { agentNeedsSetup } from './agent-state';

function subtitle(agent: WorkspaceAgent): string {
  const t = getTranslations('common').agents.list;
  if (agentNeedsSetup(agent)) return t.needsSetupPreview;
  return agent.description || t.readyPreview;
}

export function useCreateAndOpenAgent() {
  const t = getTranslations('common').agents;
  const router = useRouter();
  const createAgent = useCreateAgent();
  const create = async () => {
    if (createAgent.isPending) return;
    try {
      const res = await createAgent.mutateAsync({ name: t.detail.untitledAgent });
      if (res.data?.id) router.push(`/agents/${res.data.id}`);
    } catch {
      toast.error(t.detail.feedback.createFailed);
    }
  };
  return { create, isPending: createAgent.isPending };
}

export function AgentList() {
  const t = getTranslations('common').agents;
  const router = useRouter();
  const pathname = usePathname();
  const { data: agents = [], isLoading } = useAgents();
  const { create, isPending } = useCreateAndOpenAgent();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q),
    );
  }, [agents, search]);

  const selectedId = pathname.startsWith('/agents/') ? pathname.slice('/agents/'.length).split('/')[0] : null;

  return (
    <div className="flex h-full min-h-0 flex-col border-r bg-muted/20">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
        <span className="text-sm font-semibold">{t.list.title}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          onClick={() => void create()}
          disabled={isPending}
        >
          <Plus className="h-4 w-4" />
          {t.list.createButton}
        </Button>
      </div>

      {agents.length > 5 && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-8 w-full rounded-lg border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/25"
              placeholder={t.list.searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-2 pb-3">
          {isLoading &&
            [0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2">
                <Skeleton className="h-9 w-9 rounded-xl" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3 w-36" />
                </div>
              </div>
            ))}

          {!isLoading && agents.length > 0 && filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t.list.noResultsTitle}</p>
          )}

          {filtered.map((agent) => {
            const selected = selectedId === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => router.push(`/agents/${agent.id}`)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                  selected ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <AgentAvatar agent={agent} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{agent.name}</span>
                    {agent.status === 'paused' && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">· {t.status.paused}</span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{subtitle(agent)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
