import { useMemo, useState } from 'react';
import { Bot, Plus, Search } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { useAgents, useCreateAgent } from '@/hooks/queries/use-agent-queries';

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'paused') return 'secondary';
  return 'outline';
}

export default function AgentsPage() {
  const t = getTranslations('common');
  useBreadcrumbs([{ label: t.agents.pageTitle }]);
  const router = useRouter();
  const { data: agents = [], isLoading } = useAgents();
  const createAgent = useCreateAgent();

  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
    );
  }, [agents, search]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await createAgent.mutateAsync({ name: newName.trim() });
    setCreateOpen(false);
    setNewName('');
    if (res.data?.id) router.push(`/agents/${res.data.id}`);
  };

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b flex-shrink-0">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t.agents.list.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          {t.agents.list.createButton}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
            <Bot className="h-10 w-10 text-muted-foreground" />
            <h2 className="text-lg font-medium">
              {agents.length === 0 ? t.agents.list.emptyTitle : t.agents.list.noResultsTitle}
            </h2>
            <p className="text-sm text-muted-foreground max-w-md">
              {agents.length === 0
                ? t.agents.list.emptyDescription
                : t.agents.list.noResultsDescription}
            </p>
            {agents.length === 0 && (
              <Button onClick={() => setCreateOpen(true)}>{t.agents.list.emptyAction}</Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 max-w-4xl">
            {filtered.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => router.push(`/agents/${agent.id}`)}
                className="flex items-start gap-4 rounded-lg border bg-card p-4 text-left hover:bg-accent/40 transition-colors"
              >
                <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                  <Bot className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{agent.name}</span>
                    <Badge variant={statusVariant(agent.status)}>
                      {t.agents.status[agent.status as 'active' | 'paused' | 'draft']}
                    </Badge>
                  </div>
                  {agent.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                      {agent.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {t.agents.columns.runs}: {agent.totalRuns}
                    {agent.lastRunAt
                      ? ` · ${t.agents.columns.lastRun}: ${new Date(agent.lastRunAt).toLocaleString()}`
                      : ` · ${t.agents.relativeTime.never}`}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.agents.createDialog.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="agent-name">{t.agents.createDialog.agentNameLabel}</Label>
            <Input
              id="agent-name"
              placeholder={t.agents.createDialog.agentNamePlaceholder}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t.agents.actions.cancel}
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!newName.trim() || createAgent.isPending}
            >
              {createAgent.isPending ? t.agents.actions.creating : t.agents.actions.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
