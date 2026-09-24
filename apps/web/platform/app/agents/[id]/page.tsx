'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { AgentParityPanels } from '../components/agent-parity-panels';

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
  const [permissionFilter, setPermissionFilter] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const fb = t.agents.detail.feedback;

  useBreadcrumbs([
    { label: t.agents.pageTitle, href: '/agents' },
    { label: agent?.name ?? t.agents.detail.untitledAgent },
  ]);

  // Sync the form from the server, but never clobber unsaved edits: refetches
  // (Run now, window focus, setup finishing in chat) only update the form
  // when it still matches what was last loaded.
  const lastSynced = useRef<{
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    permissions: string[];
  } | null>(null);
  const formSnapshot = { name, description, systemPrompt, permissions };
  const isDirty =
    !!lastSynced.current &&
    (lastSynced.current.name !== name ||
      lastSynced.current.description !== description ||
      lastSynced.current.systemPrompt !== systemPrompt ||
      lastSynced.current.permissions.join('|') !== permissions.join('|'));

  useEffect(() => {
    if (!agent) return;
    const prev = lastSynced.current;
    const sameAgent = prev?.id === agent.id;
    const current = formSnapshot;
    const untouched =
      !prev ||
      (prev.name === current.name &&
        prev.description === current.description &&
        prev.systemPrompt === current.systemPrompt &&
        prev.permissions.join('|') === current.permissions.join('|'));
    if (sameAgent && !untouched) return;
    const next = {
      id: agent.id,
      name: agent.name,
      description: agent.description ?? '',
      systemPrompt: agent.systemPrompt,
      permissions: agent.permissions ?? [],
    };
    lastSynced.current = next;
    setName(next.name);
    setDescription(next.description);
    setSystemPrompt(next.systemPrompt);
    setPermissions(next.permissions);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only on server changes
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

  const filteredGrantable = useMemo(() => {
    const q = permissionFilter.trim().toLowerCase();
    return q ? sortedGrantable.filter((key) => key.toLowerCase().includes(q)) : sortedGrantable;
  }, [sortedGrantable, permissionFilter]);

  const errorMessage = (err: unknown, fallback: string) =>
    err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message
      ? err.message
      : fallback;

  const togglePermission = (key: string) => {
    setPermissions((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );
  };

  const handleSave = async () => {
    try {
      const saved = await updateAgent.mutateAsync({
        name: name.trim() || agent?.name,
        description: description.trim() || null,
        systemPrompt,
        permissions,
      });
      const data = (saved as { data?: typeof agent })?.data;
      if (data) {
        lastSynced.current = {
          id: data.id,
          name: data.name,
          description: data.description ?? '',
          systemPrompt: data.systemPrompt,
          permissions: data.permissions ?? [],
        };
        setName(data.name);
        setDescription(data.description ?? '');
        setSystemPrompt(data.systemPrompt);
        setPermissions(data.permissions ?? []);
      }
      toast.success(fb.saved);
    } catch (err) {
      toast.error(errorMessage(err, fb.saveFailed));
    }
  };

  const handleToggleStatus = async () => {
    if (!agent) return;
    try {
      if (agent.status === 'active') {
        await pauseAgent.mutateAsync(id);
        toast.success(fb.paused);
      } else {
        await activateAgent.mutateAsync(id);
        toast.success(fb.activated);
      }
    } catch (err) {
      toast.error(errorMessage(err, fb.statusFailed));
    }
  };

  const handleRun = async () => {
    try {
      const res = await runAgent.mutateAsync({ id });
      const result = (res as { data?: { success?: boolean; error?: string } })?.data;
      if (result && result.success === false) {
        toast.error(fb.runFailed.replace('{error}', result.error ?? ''));
      } else {
        toast.success(fb.runSucceeded);
      }
    } catch (err) {
      toast.error(fb.runFailed.replace('{error}', errorMessage(err, '')));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteAgent.mutateAsync(id);
      setDeleteOpen(false);
      const remaining = agents.filter((a) => a.id !== id);
      router.replace(remaining[0] ? `/agents/${remaining[0].id}` : '/agents');
    } catch (err) {
      toast.error(errorMessage(err, fb.deleteFailed));
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">{fb.loading}</div>
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
              className="h-8 gap-1"
              disabled={pauseAgent.isPending}
              onClick={() => void handleToggleStatus()}
              aria-label={t.agents.actions.pause}
            >
              <Pause className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t.agents.actions.pause}</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              disabled={activateAgent.isPending || setupPending}
              onClick={() => void handleToggleStatus()}
              aria-label={t.agents.actions.activate}
            >
              <Play className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t.agents.actions.activate}</span>
            </Button>
          )}
          {tab === 'configure' && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={runAgent.isPending || setupPending}
                onClick={() => void handleRun()}
              >
                {runAgent.isPending ? t.agents.actions.running : t.agents.actions.runNow}
              </Button>
              <Button
                size="sm"
                className="h-8"
                disabled={updateAgent.isPending || !isDirty}
                onClick={() => void handleSave()}
                title={isDirty ? fb.unsavedChanges : undefined}
              >
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

            <AgentParityPanels agentId={id} />

            <section className="space-y-3">
              <h2 className="text-sm font-medium">{t.agents.detail.sections.permissions.label}</h2>
              <p className="text-sm text-muted-foreground">
                {t.agents.detail.sections.permissions.description}
              </p>
              <Input
                value={permissionFilter}
                placeholder={fb.permissionsSearch}
                onChange={(e) => setPermissionFilter(e.target.value)}
              />
              <div className="grid sm:grid-cols-2 gap-2 max-h-64 overflow-auto rounded-md border p-3">
                {filteredGrantable.length === 0 && (
                  <p className="text-sm text-muted-foreground">{fb.permissionsNoMatch}</p>
                )}
                {filteredGrantable.map((key) => (
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
