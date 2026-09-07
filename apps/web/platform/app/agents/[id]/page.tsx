'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, MessageSquare, Play, Pause, Save, Settings2, Trash2 } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter, useParams } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Badge } from '@weldsuite/ui/components/badge';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
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
import { cn } from '@/lib/utils';
import {
  useAgent,
  useAgents,
  useUpdateAgent,
  useActivateAgent,
  usePauseAgent,
  useRunAgent,
  useDeleteAgent,
  useGrantablePermissions,
  useAgentTools,
} from '@/hooks/queries/use-agent-queries';
import { AgentChatPanel } from '../components/agent-chat-panel';
import { AgentComputerPanel } from '../components/agent-computer-panel';

type DetailTab = 'chat' | 'configure';

function agentNeedsSetup(systemPrompt: string | null | undefined): boolean {
  return !systemPrompt?.trim();
}

export default function AgentDetailPage() {
  const t = getTranslations('common');
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const { data: agent, isLoading } = useAgent(id);
  const { data: agents = [] } = useAgents();
  const { data: grantable = [] } = useGrantablePermissions();
  const { data: toolCatalog = [] } = useAgentTools();
  const updateAgent = useUpdateAgent(id);
  const activateAgent = useActivateAgent();
  const pauseAgent = usePauseAgent();
  const runAgent = useRunAgent();
  const deleteAgent = useDeleteAgent();

  const [tab, setTab] = useState<DetailTab>('chat');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useBreadcrumbs([
    { label: t.agents.pageTitle, href: '/agents' },
    { label: agent?.name ?? t.agents.detail.untitledAgent },
  ]);

  useEffect(() => {
    if (!agent) return;
    setName(agent.name);
    setDescription(agent.description ?? '');
    setSystemPrompt(agent.systemPrompt);
    setPermissions(agent.permissions ?? []);
  }, [agent]);

  // Always land on chat when switching bots.
  useEffect(() => {
    setTab('chat');
  }, [id]);

  const availableFromGrants = useMemo(() => {
    const set = new Set(permissions);
    return toolCatalog.filter((tool) =>
      tool.requiredPermissions.every((p) => set.has(p) || set.has(`${p.split(':')[0]}:*`) || set.has('*')),
    );
  }, [toolCatalog, permissions]);

  const sortedGrantable = useMemo(() => {
    const priority = new Set(['computer:use', 'browser:use']);
    return [...grantable].sort((a, b) => {
      const ap = priority.has(a) ? 0 : 1;
      const bp = priority.has(b) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.localeCompare(b);
    });
  }, [grantable]);

  const togglePermission = (key: string) => {
    setPermissions((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );
  };

  const handleSave = async () => {
    await updateAgent.mutateAsync({
      name: name.trim() || agent?.name,
      description: description.trim() || null,
      systemPrompt,
      permissions,
    });
  };

  const handleDelete = async () => {
    await deleteAgent.mutateAsync(id);
    setDeleteOpen(false);
    const remaining = agents.filter((a) => a.id !== id);
    router.replace(remaining[0] ? `/agents/${remaining[0].id}` : '/agents');
  };

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    );
  }

  if (!agent) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">{t.agents.detail.agentNotFound}</p>
        <Button variant="ghost" className="mt-2" onClick={() => router.push('/agents')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t.agents.actions.back}
        </Button>
      </div>
    );
  }

  const setupPending = agentNeedsSetup(agent.systemPrompt);

  return (
    <div className="w-full h-full bg-background flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-14 border-b flex-shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 md:hidden"
          onClick={() => router.push('/agents')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Bot className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate text-sm">{agent.name}</span>
            <Badge variant={agent.status === 'active' ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
              {t.agents.status[agent.status]}
            </Badge>
            {setupPending && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {t.agents.detail.setup.badge}
              </Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">
            {setupPending
              ? t.agents.detail.setup.headerHint
              : agent.description || t.agents.list.readyPreview}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn('h-8 gap-1.5', tab === 'chat' && 'bg-accent')}
            onClick={() => setTab('chat')}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.agents.detail.tabs.chat}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn('h-8 gap-1.5', tab === 'configure' && 'bg-accent')}
            onClick={() => setTab('configure')}
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.agents.detail.tabs.configure}</span>
          </Button>
          {agent.status === 'active' ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 hidden sm:inline-flex"
              disabled={pauseAgent.isPending}
              onClick={() => void pauseAgent.mutateAsync(id)}
            >
              <Pause className="h-3.5 w-3.5 mr-1" />
              {t.agents.actions.pause}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 hidden sm:inline-flex"
              disabled={activateAgent.isPending || setupPending}
              onClick={() => void activateAgent.mutateAsync(id)}
            >
              <Play className="h-3.5 w-3.5 mr-1" />
              {t.agents.actions.activate}
            </Button>
          )}
          {tab === 'configure' && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={runAgent.isPending || setupPending}
                onClick={() => void runAgent.mutateAsync({ id })}
              >
                {runAgent.isPending ? t.agents.actions.running : t.agents.actions.runNow}
              </Button>
              <Button size="sm" className="h-8" disabled={updateAgent.isPending} onClick={() => void handleSave()}>
                <Save className="h-3.5 w-3.5 mr-1" />
                {updateAgent.isPending ? t.agents.actions.saving : t.agents.actions.save}
              </Button>
            </>
          )}
        </div>
      </div>

      {tab === 'chat' ? (
        <div className="flex-1 min-h-0">
          <AgentChatPanel
            agentId={id}
            agentName={agent.name}
            needsSetup={setupPending}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto p-6 space-y-8">
            <section className="space-y-3">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground">
                {t.agents.detail.configureHeading}
              </h2>
              <div className="space-y-2">
                <Label>{t.agents.detail.general.nameLabel}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t.agents.detail.general.descriptionLabel}</Label>
                <Input
                  value={description}
                  placeholder={t.agents.detail.general.descriptionPlaceholder}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t.agents.detail.sections.instructions.label}</Label>
                <Textarea
                  className="min-h-[160px]"
                  value={systemPrompt}
                  placeholder={t.agents.detail.instructions.placeholder}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                />
              </div>
            </section>

            <AgentComputerPanel agentId={id} />

            <section className="space-y-3">
              <h2 className="text-sm font-medium">{t.agents.detail.sections.permissions.label}</h2>
              <p className="text-sm text-muted-foreground">
                {t.agents.detail.sections.permissions.description}
              </p>
              <div className="grid sm:grid-cols-2 gap-2 max-h-64 overflow-auto rounded-md border p-3">
                {sortedGrantable.slice(0, 80).map((key) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={permissions.includes(key)}
                      onCheckedChange={() => togglePermission(key)}
                    />
                    <span className="font-mono text-xs">{key}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t.agents.detail.sections.permissions.unlockedTools}:{' '}
                {availableFromGrants.length
                  ? availableFromGrants.map((tool) => tool.name).join(', ')
                  : t.agents.detail.sections.permissions.none}
              </p>
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium">{t.agents.detail.sections.listening.label}</h2>
              <div className="flex flex-wrap gap-2">
                {(agent.eventSubscriptions ?? []).length === 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {t.agents.detail.sections.listening.empty}
                  </span>
                ) : (
                  agent.eventSubscriptions.map((ev) => (
                    <Badge key={ev} variant="outline">
                      {ev}
                    </Badge>
                  ))
                )}
              </div>
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-medium">{t.agents.detail.tabs.activity}</h2>
              {(agent.recentRuns ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.agents.detail.runs.emptyDescription}</p>
              ) : (
                <div className="space-y-2">
                  {agent.recentRuns.map((run) => (
                    <div key={run.id} className="rounded-md border p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{run.status}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {run.triggerType} · {new Date(run.createdAt).toLocaleString()}
                        </span>
                      </div>
                      {run.result?.summary && (
                        <p className="mt-2 text-muted-foreground line-clamp-3">{run.result.summary}</p>
                      )}
                      {run.error && <p className="mt-2 text-destructive">{run.error}</p>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3 rounded-lg border border-destructive/30 p-4">
              <div>
                <h2 className="text-sm font-medium text-destructive">
                  {t.agents.detail.sections.danger.label}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {t.agents.detail.sections.danger.description}
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                {t.agents.actions.deleteAgent}
              </Button>
            </section>
          </div>
        </div>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t.agents.deleteDialog.titleNamed.replace('{name}', agent.name)}
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
                void handleDelete();
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
