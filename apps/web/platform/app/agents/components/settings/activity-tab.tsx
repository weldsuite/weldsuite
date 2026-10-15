'use client';

import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useRunAgent, type AgentRun, type AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import { errorMessage } from '../chat/labels';
import { agentNeedsSetup } from '../agent-state';
import { SettingsSection } from './general-tab';

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  running: 'bg-sky-500 animate-pulse',
  cancelled: 'bg-muted-foreground',
  deferred: 'bg-amber-500',
};

function RunRow({ run }: Readonly<{ run: AgentRun }>) {
  const t = getTranslations('common').agents.detail;
  const status = run.status in t.runStatus ? t.runStatus[run.status as keyof typeof t.runStatus] : run.status;
  return (
    <li className="px-3.5 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[run.status] ?? 'bg-muted-foreground')} />
        <span className="font-medium">{status}</span>
        {run.triggerType && <span className="text-muted-foreground">· {run.triggerType}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
      </div>
      {run.result?.summary && (
        <p className="mt-1.5 line-clamp-3 pl-4 text-xs leading-relaxed text-muted-foreground">{run.result.summary}</p>
      )}
      {run.error && <p className="mt-1.5 pl-4 text-xs text-destructive">{run.error}</p>}
    </li>
  );
}

export function ActivityTab({ agent }: Readonly<{ agent: AgentWithRuns }>) {
  const t = getTranslations('common').agents;
  const runAgent = useRunAgent();
  const runs = agent.recentRuns ?? [];

  const run = async () => {
    try {
      const res = await runAgent.mutateAsync({ id: agent.id });
      const result = (res as { data?: { success?: boolean; error?: string } })?.data;
      if (result?.success === false) toast.error(t.detail.feedback.runFailed.replace('{error}', result.error ?? ''));
      else toast.success(t.detail.feedback.runSucceeded);
    } catch (err) {
      toast.error(t.detail.feedback.runFailed.replace('{error}', errorMessage(err, '')));
    }
  };

  return (
    <SettingsSection title={t.detail.settings.activity.title} description={t.detail.settings.activity.description}>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={runAgent.isPending || agentNeedsSetup(agent)}
        onClick={() => void run()}
      >
        <Play className="h-3.5 w-3.5" />
        {runAgent.isPending ? t.actions.running : t.actions.runNow}
      </Button>
      {runs.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
          {t.detail.runs.emptyDescription}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
