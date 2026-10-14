'use client';

import { useState } from 'react';
import { CalendarClock, FlaskConical, Plus, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Badge } from '@weldsuite/ui/components/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import type { AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import {
  useAgentRoutines,
  useCreateAgentRoutine,
  useDeleteAgentRoutine,
  useTestAgentRoutine,
  useUpdateAgentRoutine,
  type AgentRoutine,
} from '@/hooks/queries/use-agent-parity-queries';
import { errorMessage } from '../chat/labels';
import { SettingsSection } from './general-tab';

type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
const SCHEDULE_PRESETS: SchedulePreset[] = ['hourly', 'daily', 'weekdays', 'weekly', 'custom'];

const SCHEDULE_CRON: Record<Exclude<SchedulePreset, 'custom'>, string> = {
  hourly: '0 * * * *',
  daily: '0 8 * * *',
  weekdays: '0 8 * * 1-5',
  weekly: '0 8 * * 1',
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function scheduleLabel(routine: AgentRoutine): string {
  const t = getTranslations('common').agents.detail.parity.routines;
  if (routine.scheduleKind === 'event' && routine.eventKey) return t.onEvent.replace('{event}', routine.eventKey);
  const preset = (Object.keys(SCHEDULE_CRON) as Array<keyof typeof SCHEDULE_CRON>).find(
    (key) => SCHEDULE_CRON[key] === routine.cronExpr,
  );
  return preset ? t.schedules[preset] : (routine.cronExpr ?? routine.scheduleKind);
}

function RoutineCard({ agentId, routine }: Readonly<{ agentId: string; routine: AgentRoutine }>) {
  const t = getTranslations('common').agents.detail.parity;
  const update = useUpdateAgentRoutine(agentId);
  const remove = useDeleteAgentRoutine(agentId);
  const test = useTestAgentRoutine(agentId);
  const onError = (err: unknown) => toast.error(errorMessage(err, t.actionFailed));

  return (
    <div className="rounded-xl border p-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{routine.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            {scheduleLabel(routine)}
            {routine.enabled && routine.nextRunAt && (
              <span>· {t.routines.next.replace('{time}', new Date(routine.nextRunAt).toLocaleString())}</span>
            )}
          </p>
        </div>
        <Switch
          checked={routine.enabled}
          disabled={update.isPending}
          aria-label={routine.enabled ? t.routines.pause : t.routines.resume}
          onCheckedChange={(enabled) => update.mutate({ id: routine.id, data: { enabled } }, { onError })}
        />
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{routine.instructions}</p>
      <div className="mt-2.5 flex items-center gap-1">
        {routine.requireApproval && <Badge variant="outline" className="mr-auto text-[10px]">{t.routines.approvalBadge}</Badge>}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 gap-1.5 px-2 text-xs"
          disabled={test.isPending}
          onClick={() =>
            test.mutate(routine.id, {
              onSuccess: () => toast.success(t.routines.testStarted),
              onError: (err) => toast.error(t.routines.testFailed.replace('{error}', errorMessage(err, ''))),
            })
          }
        >
          <FlaskConical className="h-3.5 w-3.5" />
          {test.isPending ? t.routines.testing : t.routines.test}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          aria-label={t.routines.delete}
          disabled={remove.isPending}
          onClick={() => remove.mutate(routine.id, { onError })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function NewRoutine({ agentId, onDone }: Readonly<{ agentId: string; onDone: () => void }>) {
  const t = getTranslations('common').agents.detail.parity;
  const create = useCreateAgentRoutine(agentId);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [preset, setPreset] = useState<SchedulePreset>('daily');
  const [customCron, setCustomCron] = useState('');
  const [requireApproval, setRequireApproval] = useState(true);

  const cronExpr = preset === 'custom' ? customCron.trim() : SCHEDULE_CRON[preset];
  const valid =
    name.trim().length >= 2 &&
    instructions.trim().length >= 10 &&
    cronExpr.split(/\s+/).filter(Boolean).length === 5;

  const submit = async () => {
    try {
      await create.mutateAsync({
        name: name.trim(),
        instructions: instructions.trim(),
        scheduleKind: 'cron',
        cronExpr,
        timezone: browserTimezone(),
        requireApproval,
      });
      toast.success(t.routines.created);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err, t.actionFailed));
    }
  };

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3.5">
      <Input placeholder={t.routines.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <Textarea
        placeholder={t.routines.instructionsPlaceholder}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={preset} onValueChange={(v) => setPreset(v as SchedulePreset)}>
          <SelectTrigger className="h-9 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((key) => (
              <SelectItem key={key} value={key}>
                {t.routines.schedules[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {preset === 'custom' && (
          <Input
            className="h-9 w-44 font-mono text-xs"
            placeholder={t.routines.cronPlaceholder}
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
          />
        )}
      </div>
      <label className="flex items-start gap-2.5 text-sm">
        <Switch checked={requireApproval} onCheckedChange={setRequireApproval} className="mt-0.5" />
        <span className="text-xs leading-relaxed text-muted-foreground">{t.routines.requireApproval}</span>
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {getTranslations('common').agents.actions.cancel}
        </Button>
        <Button size="sm" disabled={!valid || create.isPending} onClick={() => void submit()}>
          {t.routines.create}
        </Button>
      </div>
    </div>
  );
}

export function RoutinesTab({ agent }: Readonly<{ agent: AgentWithRuns }>) {
  const t = getTranslations('common').agents.detail;
  const routines = useAgentRoutines(agent.id);
  const [adding, setAdding] = useState(false);
  const list = routines.data ?? [];

  return (
    <div className="space-y-8">
      <SettingsSection title={t.parity.routines.title} description={t.parity.routines.hint}>
        {routines.isError && <p className="text-xs text-destructive">{t.parity.loadFailed}</p>}
        {!routines.isLoading && list.length === 0 && !adding && (
          <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
            {t.parity.routines.empty}
          </p>
        )}
        <div className="space-y-2">
          {list.map((routine) => (
            <RoutineCard key={routine.id} agentId={agent.id} routine={routine} />
          ))}
        </div>
        {adding ? (
          <NewRoutine agentId={agent.id} onDone={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t.parity.routines.add}
          </Button>
        )}
      </SettingsSection>

      <SettingsSection title={t.sections.listening.label} description={t.settings.listeningHint}>
        {agent.eventSubscriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.sections.listening.empty}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {agent.eventSubscriptions.map((ev) => (
              <Badge key={ev} variant="secondary" className="gap-1 font-mono text-[11px] font-normal">
                <Zap className="h-3 w-3" />
                {ev}
              </Badge>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
