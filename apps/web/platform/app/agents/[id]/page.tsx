'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, CalendarClock, Pause, Play, Settings2 } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useParams, useRouter, useSearchParams } from '@/lib/router';
import { getLocale, getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { useActivateAgent, useAgent, useAgentMainChat, usePauseAgent } from '@/hooks/queries/use-agent-queries';
import { useAgentRoutines } from '@/hooks/queries/use-agent-parity-queries';
import { AgentAvatar } from '../components/agent-avatar';
import { agentNeedsSetup } from '../components/agent-state';
import { AgentChat } from '../components/chat/agent-chat';
import { ChatSkeleton } from '../components/chat/chat-skeleton';
import { errorMessage } from '../components/chat/labels';
import { AgentSettingsSheet, SETTINGS_TABS, type SettingsTab } from '../components/settings/agent-settings-sheet';
import { formatNextRun } from '../components/routine-schedule';

function StatusButton({ agentId, status }: Readonly<{ agentId: string; status: string }>) {
  const t = getTranslations('common').agents;
  const activate = useActivateAgent();
  const pause = usePauseAgent();
  const active = status === 'active';

  const toggle = async () => {
    try {
      if (active) {
        await pause.mutateAsync(agentId);
        toast.success(t.detail.feedback.paused);
      } else {
        await activate.mutateAsync(agentId);
        toast.success(t.detail.feedback.activated);
      }
    } catch (err) {
      toast.error(errorMessage(err, t.detail.feedback.statusFailed));
    }
  };

  return (
    <Button
      size="sm"
      variant={active ? 'ghost' : 'default'}
      className="h-8 gap-1.5"
      disabled={activate.isPending || pause.isPending}
      onClick={() => void toggle()}
      title={active ? t.detail.header.pauseHint : t.detail.header.activateHint}
    >
      {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{active ? t.actions.pause : t.actions.activate}</span>
    </Button>
  );
}

/** The agent's live routines, as a header button that opens them. */
function ScheduledButton({ agentId, onOpen }: Readonly<{ agentId: string; onOpen: () => void }>) {
  const t = getTranslations('common').agents.detail.header;
  const { data: routines = [] } = useAgentRoutines(agentId);
  const live = routines.filter((r) => r.enabled);
  if (live.length === 0) return null;
  const next = live
    .map((r) => ({ at: r.nextRunAt, tz: r.timezone }))
    .filter((r): r is { at: string; tz: string } => Boolean(r.at))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const title = next ? t.nextRun.replace('{time}', formatNextRun(next.at, next.tz, getLocale())) : undefined;
  return (
    <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={onOpen} title={title}>
      <CalendarClock className="h-4 w-4" />
      <span className="hidden sm:inline">{t.scheduled.replace('{count}', String(live.length))}</span>
    </Button>
  );
}

function isSettingsTab(value: string | null): value is SettingsTab {
  return !!value && (SETTINGS_TABS as readonly string[]).includes(value);
}

export default function AgentDetailPage() {
  const t = getTranslations('common').agents;
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  // Links from notifications: ?settings=<tab> opens the sheet. (Chat links all
  // land here: each person has one continuous chat with an agent.)
  const linkedTab = search.get('settings');
  const { data: agent, isLoading } = useAgent(id);
  const { data: mainChat } = useAgentMainChat(agent ? id : '');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

  useBreadcrumbs([{ label: t.pageTitle, href: '/agents' }, { label: agent?.name ?? t.detail.untitledAgent }]);

  // Each agent opens on its chat, with the sheet closed unless linked.
  useEffect(() => {
    setSettingsOpen(isSettingsTab(linkedTab));
    if (isSettingsTab(linkedTab)) setSettingsTab(linkedTab);
  }, [id, linkedTab]);

  // Another agent's page is opening: show its loading state, never the previous agent's chat.
  if (isLoading || (agent && agent.id !== id)) {
    return (
      <div className="flex h-full w-full flex-col bg-background" key={id}>
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <ChatSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t.detail.agentNotFound}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/agents')}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          {t.actions.back}
        </Button>
      </div>
    );
  }

  const setup = agentNeedsSetup(agent);

  const openSettings = (tab: SettingsTab = 'general') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  let subtitle = agent.description || t.list.readyPreview;
  if (setup) subtitle = t.detail.header.settingUp;
  else if (agent.status !== 'active') subtitle = t.detail.header.notActive;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 md:hidden"
          onClick={() => router.push('/agents')}
          aria-label={t.actions.back}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left"
          onClick={() => openSettings('general')}
        >
          <AgentAvatar agent={agent} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{agent.name}</span>
            <span className={cn('block truncate text-xs', setup ? 'text-amber-600' : 'text-muted-foreground')}>
              {subtitle}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <ScheduledButton agentId={agent.id} onOpen={() => openSettings('routines')} />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => openSettings()}
            aria-label={t.detail.settings.title}
            title={t.detail.settings.title}
          >
            <Settings2 className="h-4 w-4" />
          </Button>
          {!setup && <StatusButton agentId={agent.id} status={agent.status} />}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <AgentChat
          key={agent.id}
          agentId={agent.id}
          agentName={agent.name}
          needsSetup={setup}
          conversationId={mainChat?.id ?? null}
          onOpenRoutines={() => openSettings('routines')}
        />
      </div>

      <AgentSettingsSheet
        key={agent.id}
        agent={agent}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
      />
    </div>
  );
}
