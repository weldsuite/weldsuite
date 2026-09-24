'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Brain, Clock, Monitor, Share2, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { getTranslations } from '@/lib/i18n';
import { useAppApi } from '@/lib/api/use-app-api';
import {
  useAgentApprovals,
  useAgentMemories,
  useAgentRoutines,
  useAgentSkills,
  useCreateAgentMemory,
  useCreateAgentRoutine,
  useCreateAgentSkill,
  useDecideAgentApproval,
  useDeleteAgentMemory,
  useDeleteAgentRoutine,
  useDisableAgentSkill,
  useTestAgentRoutine,
  useUpdateAgentRoutine,
  type AgentRoutine,
} from '@/hooks/queries/use-agent-parity-queries';

interface AgentParityPanelsProps {
  agentId: string;
}

type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

const SCHEDULE_CRON: Record<Exclude<SchedulePreset, 'custom'>, string> = {
  hourly: '0 * * * *',
  daily: '0 8 * * *',
  weekdays: '0 8 * * 1-5',
  weekly: '0 8 * * 1',
};

function errorText(err: unknown, fallback: string): string {
  return err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message
    ? err.message
    : fallback;
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof BookOpen;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function StateLine({ loading, error, empty, emptyText }: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  emptyText: string;
}) {
  const t = getTranslations('common').agents.detail;
  if (loading) return <p className="text-xs text-muted-foreground">{t.feedback.loading}</p>;
  if (error) return <p className="text-xs text-destructive">{t.parity.loadFailed}</p>;
  if (empty) return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  return null;
}

function routineScheduleLabel(routine: AgentRoutine): string {
  const t = getTranslations('common').agents.detail.parity.routines;
  if (routine.scheduleKind === 'event' && routine.eventKey) {
    return t.onEvent.replace('{event}', routine.eventKey);
  }
  if (routine.scheduleKind === 'cron' && routine.nextRunAt && routine.enabled) {
    return t.next.replace('{time}', new Date(routine.nextRunAt).toLocaleString());
  }
  return routine.cronExpr ?? routine.scheduleKind;
}

function SkillsSection({ agentId }: { agentId: string }) {
  const t = getTranslations('common').agents.detail.parity;
  const skills = useAgentSkills(agentId);
  const createSkill = useCreateAgentSkill(agentId);
  const disableSkill = useDisableAgentSkill(agentId);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');

  const valid = name.trim().length >= 2 && instructions.trim().length >= 20;

  const save = async () => {
    if (!valid) {
      toast.error(t.skills.invalid);
      return;
    }
    try {
      await createSkill.mutateAsync({ name: name.trim(), instructions: instructions.trim() });
      setName('');
      setInstructions('');
      toast.success(t.skills.saved);
    } catch (err) {
      toast.error(errorText(err, t.actionFailed));
    }
  };

  const list = skills.data ?? [];
  return (
    <Section icon={BookOpen} title={t.skills.title}>
      <StateLine
        loading={skills.isLoading}
        error={skills.isError}
        empty={list.length === 0}
        emptyText={t.skills.empty}
      />
      <div className="space-y-2">
        {list.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{s.name}</span>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="secondary">{s.status}</Badge>
              <Button
                size="sm"
                variant="ghost"
                disabled={disableSkill.isPending}
                onClick={() =>
                  disableSkill.mutate(s.id, { onError: (err) => toast.error(errorText(err, t.actionFailed)) })
                }
              >
                {t.skills.disable}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Input placeholder={t.skills.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
      <Textarea
        placeholder={t.skills.instructionsPlaceholder}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={3}
      />
      <Button size="sm" disabled={createSkill.isPending || !valid} onClick={() => void save()}>
        {t.skills.save}
      </Button>
    </Section>
  );
}

function RoutinesSection({ agentId }: { agentId: string }) {
  const t = getTranslations('common').agents.detail.parity;
  const routines = useAgentRoutines(agentId);
  const createRoutine = useCreateAgentRoutine(agentId);
  const updateRoutine = useUpdateAgentRoutine(agentId);
  const deleteRoutine = useDeleteAgentRoutine(agentId);
  const testRoutine = useTestAgentRoutine(agentId);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [preset, setPreset] = useState<SchedulePreset>('daily');
  const [customCron, setCustomCron] = useState('');
  const [requireApproval, setRequireApproval] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  const cronExpr = preset === 'custom' ? customCron.trim() : SCHEDULE_CRON[preset];
  const valid =
    name.trim().length >= 2 &&
    instructions.trim().length >= 10 &&
    cronExpr.split(/\s+/).filter(Boolean).length === 5;

  const onError = (err: unknown) => toast.error(errorText(err, t.actionFailed));

  const create = async () => {
    if (!valid) {
      toast.error(t.routines.invalid);
      return;
    }
    try {
      await createRoutine.mutateAsync({
        name: name.trim(),
        instructions: instructions.trim(),
        scheduleKind: 'cron',
        cronExpr,
        timezone: browserTimezone(),
        requireApproval,
      });
      setName('');
      setInstructions('');
      toast.success(t.routines.created);
    } catch (err) {
      onError(err);
    }
  };

  const test = async (id: string) => {
    setTestingId(id);
    try {
      const result = await testRoutine.mutateAsync(id);
      if (result?.success === false) {
        toast.error(t.routines.testFailed.replace('{error}', result.error ?? ''));
      } else {
        toast.success(t.routines.testDone);
      }
    } catch (err) {
      toast.error(t.routines.testFailed.replace('{error}', errorText(err, '')));
    } finally {
      setTestingId(null);
    }
  };

  const list = routines.data ?? [];
  return (
    <Section icon={Clock} title={t.routines.title}>
      <StateLine
        loading={routines.isLoading}
        error={routines.isError}
        empty={list.length === 0}
        emptyText={t.routines.empty}
      />
      {list.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="min-w-0">
            <div className="truncate">{r.name}</div>
            <div className="text-xs text-muted-foreground">{routineScheduleLabel(r)}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={r.enabled ? 'default' : 'secondary'}>
              {r.enabled ? t.routines.on : t.routines.off}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={testingId !== null}
              onClick={() => void test(r.id)}
            >
              {testingId === r.id ? t.routines.testing : t.routines.test}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={updateRoutine.isPending}
              onClick={() => updateRoutine.mutate({ id: r.id, data: { enabled: !r.enabled } }, { onError })}
            >
              {r.enabled ? t.routines.pause : t.routines.resume}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              aria-label={t.routines.delete}
              disabled={deleteRoutine.isPending}
              onClick={() => deleteRoutine.mutate(r.id, { onError })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
      <Input placeholder={t.routines.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
      <Textarea
        placeholder={t.routines.instructionsPlaceholder}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor={`routine-schedule-${agentId}`}>
          {t.routines.scheduleLabel}
        </label>
        <select
          id={`routine-schedule-${agentId}`}
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={preset}
          onChange={(e) => setPreset(e.target.value as SchedulePreset)}
        >
          {(['hourly', 'daily', 'weekdays', 'weekly', 'custom'] as const).map((key) => (
            <option key={key} value={key}>
              {t.routines.schedules[key]}
            </option>
          ))}
        </select>
        {preset === 'custom' && (
          <Input
            className="h-9 w-48 font-mono text-xs"
            placeholder={t.routines.cronPlaceholder}
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
          />
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={requireApproval} onCheckedChange={(v) => setRequireApproval(v === true)} />
        {t.routines.requireApproval}
      </label>
      <p className="text-xs text-muted-foreground">{t.routines.hint}</p>
      <Button size="sm" disabled={createRoutine.isPending || !valid} onClick={() => void create()}>
        {t.routines.create}
      </Button>
    </Section>
  );
}

function ApprovalsSection({ agentId }: { agentId: string }) {
  const t = getTranslations('common').agents.detail.parity;
  const approvals = useAgentApprovals(agentId);
  const decide = useDecideAgentApproval(agentId);

  const onDecide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      const res = await decide.mutateAsync({ id, decision });
      if (decision === 'rejected') {
        toast.success(t.approvals.rejected);
      } else if (res?.execution && !res.execution.ok) {
        toast.error(t.approvals.approvedFailed.replace('{error}', res.execution.error ?? ''));
      } else {
        toast.success(t.approvals.approved);
      }
    } catch (err) {
      toast.error(errorText(err, t.actionFailed));
    }
  };

  const list = approvals.data ?? [];
  return (
    <Section icon={ShieldCheck} title={t.approvals.title}>
      <StateLine
        loading={approvals.isLoading}
        error={approvals.isError}
        empty={list.length === 0}
        emptyText={t.approvals.empty}
      />
      {list.map((a) => (
        <div key={a.id} className="space-y-1.5 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{a.toolName.replace(/_/g, ' ')}</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={decide.isPending} onClick={() => void onDecide(a.id, 'approved')}>
                {t.approvals.approve}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() => void onDecide(a.id, 'rejected')}
              >
                {t.approvals.reject}
              </Button>
            </div>
          </div>
          <pre className="max-h-32 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
            {JSON.stringify(a.args, null, 2)}
          </pre>
        </div>
      ))}
    </Section>
  );
}

function MemorySection({ agentId }: { agentId: string }) {
  const t = getTranslations('common').agents.detail.parity;
  const memories = useAgentMemories(agentId);
  const createMemory = useCreateAgentMemory(agentId);
  const deleteMemory = useDeleteAgentMemory(agentId);
  const [content, setContent] = useState('');

  const onError = (err: unknown) => toast.error(errorText(err, t.actionFailed));
  const list = memories.data ?? [];
  return (
    <Section icon={Brain} title={t.memory.title}>
      <StateLine
        loading={memories.isLoading}
        error={memories.isError}
        empty={list.length === 0}
        emptyText={t.memory.empty}
      />
      {list.map((m) => (
        <div key={m.id} className="flex items-start justify-between gap-2 text-sm">
          <div className="min-w-0">
            <Badge variant="outline" className="mr-2">
              {m.kind}
            </Badge>
            {m.content}
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={deleteMemory.isPending}
            onClick={() => deleteMemory.mutate(m.id, { onError })}
          >
            {t.memory.delete}
          </Button>
        </div>
      ))}
      <Textarea
        placeholder={t.memory.placeholder}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
      />
      <Button
        size="sm"
        disabled={createMemory.isPending || !content.trim()}
        onClick={() =>
          createMemory.mutate(content.trim(), { onSuccess: () => setContent(''), onError })
        }
      >
        {t.memory.save}
      </Button>
    </Section>
  );
}

function TemplateSection({ agentId }: { agentId: string }) {
  const t = getTranslations('common').agents.detail.parity;
  const { weldAgentParity } = useAppApi();
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportTemplate = async () => {
    setBusy(true);
    try {
      const tpl = await weldAgentParity.exportTemplate({ agentId, isPublic: false });
      setShareToken((tpl.data as { shareToken?: string }).shareToken ?? null);
      toast.success(t.templates.exported);
    } catch (err) {
      toast.error(errorText(err, t.actionFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={Share2} title={t.templates.title}>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportTemplate()}>
        {t.templates.export}
      </Button>
      {shareToken ? (
        <p className="text-xs font-mono break-all">{t.templates.shareToken.replace('{token}', shareToken)}</p>
      ) : null}
    </Section>
  );
}

function ComputerSection({ agentId }: { agentId: string }) {
  const t = getTranslations('common').agents.detail.parity;
  const { weldAgentParity } = useAppApi();
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ['weldagent-parity', 'computer-files', agentId],
    queryFn: async () => (await weldAgentParity.listComputerFiles(agentId, '/workspace')).data,
    retry: false,
  });

  const openLiveView = async () => {
    try {
      const res = await weldAgentParity.liveView(agentId);
      setLiveViewUrl((res.data as { liveViewUrl?: string }).liveViewUrl ?? null);
    } catch (err) {
      toast.error(errorText(err, t.actionFailed));
    }
  };

  return (
    <Section icon={Monitor} title={t.computer.title}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void openLiveView()}>
          {t.computer.liveView}
        </Button>
        <Button size="sm" variant="outline" disabled={files.isFetching} onClick={() => void files.refetch()}>
          {t.computer.refreshFiles}
        </Button>
      </div>
      {liveViewUrl ? (
        <iframe title={t.computer.liveView} src={liveViewUrl} className="h-64 w-full rounded-lg border bg-black" />
      ) : null}
      {files.isError ? (
        <p className="text-xs text-muted-foreground">{t.loadFailed}</p>
      ) : files.data ? (
        <pre className="max-h-40 overflow-auto rounded-lg bg-muted/40 p-2 text-[11px]">
          {JSON.stringify(files.data, null, 2)}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">{t.computer.noFiles}</p>
      )}
    </Section>
  );
}

export function AgentParityPanels({ agentId }: AgentParityPanelsProps) {
  return (
    <div className="space-y-6">
      <ApprovalsSection agentId={agentId} />
      <RoutinesSection agentId={agentId} />
      <SkillsSection agentId={agentId} />
      <MemorySection agentId={agentId} />
      <TemplateSection agentId={agentId} />
      <ComputerSection agentId={agentId} />
    </div>
  );
}
