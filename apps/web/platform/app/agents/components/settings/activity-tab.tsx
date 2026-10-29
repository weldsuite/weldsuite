'use client';

import { useState } from 'react';
import { ChevronDown, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { AssistantMessage } from '@/components/weldagent/chat/chat-message';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useAgentRuns, useRunAgent, type AgentRun, type AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import { errorMessage } from '../chat/labels';
import { agentNeedsSetup } from '../agent-state';
import { SettingsSection } from './general-tab';
import { isLongSummary, runTrigger } from './run-labels';

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  running: 'bg-sky-500 animate-pulse',
  queued: 'bg-sky-500 animate-pulse',
  cancelled: 'bg-muted-foreground',
  deferred: 'bg-amber-500',
};

function RunRow({ run }: Readonly<{ run: AgentRun }>) {
  const t = getTranslations('common').agents.detail;
  const [expanded, setExpanded] = useState(false);
  const status = run.status in t.runStatus ? t.runStatus[run.status as keyof typeof t.runStatus] : run.status;
  const trigger = runTrigger(run);
  const triggerLabel = trigger ? t.runs.triggers[trigger] : run.triggerType;
  const summary = run.result?.summary?.trim() ?? '';
  const long = isLongSummary(summary);

  return (
    <li className="px-3.5 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[run.status] ?? 'bg-muted-foreground')} />
        <span className="font-medium">{status}</span>
        {triggerLabel && <span className="text-muted-foreground">· {triggerLabel}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
      </div>
      {summary && (
        <div className="mt-1.5 pl-4">
          <div className={cn('relative', long && !expanded && 'max-h-[4.75rem] overflow-hidden')}>
            <AssistantMessage
              content={summary}
              className="text-xs leading-relaxed text-muted-foreground prose-p:my-1 prose-headings:my-1.5 prose-headings:text-xs prose-li:text-xs"
            />
            {long && !expanded && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background to-transparent"
              />
            )}
          </div>
          {long && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
              {expanded ? t.runs.showLess : t.runs.showMore}
            </button>
          )}
        </div>
      )}
      {run.error && <p className="mt-1.5 pl-4 text-xs text-destructive">{run.error}</p>}
    </li>
  );
}

function RunsSkeleton() {
  return (
    <ul className="divide-y rounded-xl border" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="space-y-2 px-3.5 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-3/4" />
        </li>
      ))}
    </ul>
  );
}

export function ActivityTab({ agent }: Readonly<{ agent: AgentWithRuns }>) {
  const t = getTranslations('common').agents;
  const runAgent = useRunAgent();
  const runsQuery = useAgentRuns(agent.id);
  // The list the agent page loaded first, until this tab has its own.
  const runs = runsQuery.data?.runs ?? agent.recentRuns ?? [];
  const loading = runsQuery.isLoading && runs.length === 0;

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

  const empty = agent.status === 'active' ? t.detail.runs.emptyActive : t.detail.runs.emptyDescription;

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
      {loading && <RunsSkeleton />}
      {!loading && runs.length === 0 && (
        <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{empty}</p>
      )}
      {runs.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
