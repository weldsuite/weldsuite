'use client';

import { useMemo, useState } from 'react';
import { Bot, Plus, Search, Trash2 } from 'lucide-react';
import { usePathname, useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { cn } from '@/lib/utils';
import { useAgents, useCreateAgent, useDeleteAgent } from '@/hooks/queries/use-agent-queries';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'paused') return 'secondary';
  return 'outline';
}

function needsSetup(systemPrompt: string | null | undefined): boolean {
  return !systemPrompt?.trim();
}

export function AgentsBotList() {
  const t = getTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const { data: agents = [], isLoading } = useAgents();
  const createAgent = useCreateAgent();
  const deleteAgent = useDeleteAgent();

  const [search, setSearch] = useState('');
  const [agentToDelete, setAgentToDelete] = useState<WorkspaceAgent | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
    );
  }, [agents, search]);

  const selectedId = pathname.startsWith('/agents/')
    ? pathname.slice('/agents/'.length).split('/')[0]
    : null;

  const handleCreate = async () => {
    if (createAgent.isPending) return;
    const res = await createAgent.mutateAsync({
      name: t.agents.detail.untitledAgent,
    });
    if (res.data?.id) router.push(`/agents/${res.data.id}`);
  };

  const handleConfirmDelete = async () => {
    if (!agentToDelete) return;
    const deletedId = agentToDelete.id;
    await deleteAgent.mutateAsync(deletedId);
    setAgentToDelete(null);

    if (selectedId === deletedId) {
      const remaining = agents.filter((a) => a.id !== deletedId);
      router.replace(remaining[0] ? `/agents/${remaining[0].id}` : '/agents');
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="flex items-center gap-2 border-b px-3 py-3 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9 h-9"
            placeholder={t.agents.list.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => void handleCreate()}
          disabled={createAgent.isPending}
          aria-label={t.agents.list.createButton}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 space-y-0.5">
          {isLoading && (
            <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
              <Bot className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">
                {agents.length === 0 ? t.agents.list.emptyTitle : t.agents.list.noResultsTitle}
              </p>
              <p className="text-xs text-muted-foreground">
                {agents.length === 0
                  ? t.agents.list.emptyDescription
                  : t.agents.list.noResultsDescription}
              </p>
              {agents.length === 0 && (
                <Button
                  size="sm"
                  className="mt-2"
                  disabled={createAgent.isPending}
                  onClick={() => void handleCreate()}
                >
                  {t.agents.list.emptyAction}
                </Button>
              )}
            </div>
          )}
          {filtered.map((agent) => {
            const selected = selectedId === agent.id;
            const setup = needsSetup(agent.systemPrompt);
            return (
              <div
                key={agent.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/agents/${agent.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    router.push(`/agents/${agent.id}`);
                  }
                }}
                className={cn(
                  'group w-full flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer',
                  selected ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <div
                  className={cn(
                    'h-11 w-11 rounded-full flex items-center justify-center shrink-0',
                    selected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate text-sm">{agent.name}</span>
                    <Badge variant={statusVariant(agent.status)} className="shrink-0 text-[10px] px-1.5 py-0">
                      {t.agents.status[agent.status as 'active' | 'paused' | 'draft']}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {setup
                      ? t.agents.list.needsSetupPreview
                      : agent.description || t.agents.list.readyPreview}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive"
                  aria-label={t.agents.actions.deleteAgent}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAgentToDelete(agent);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      <AlertDialog
        open={!!agentToDelete}
        onOpenChange={(open) => {
          if (!open) setAgentToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {agentToDelete
                ? t.agents.deleteDialog.titleNamed.replace('{name}', agentToDelete.name)
                : t.agents.deleteDialog.title}
            </AlertDialogTitle>
            <AlertDialogDescription>{t.agents.deleteDialog.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAgent.isPending}>
              {t.agents.actions.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAgent.isPending}
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmDelete();
              }}
            >
              {t.agents.actions.deleteAgent}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
