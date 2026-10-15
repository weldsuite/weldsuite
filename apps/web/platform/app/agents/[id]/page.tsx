'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, History, Pause, Play, Settings2, SquarePen } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useParams, useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { useActivateAgent, useAgent, usePauseAgent } from '@/hooks/queries/use-agent-queries';
import { useWeldAgentConversations } from '@/hooks/queries/use-weldagent-queries';
import { AgentAvatar } from '../components/agent-avatar';
import { agentNeedsSetup } from '../components/agent-state';
import { AgentChat } from '../components/chat/agent-chat';
import { errorMessage } from '../components/chat/labels';
import { AgentSettingsSheet, type SettingsTab } from '../components/settings/agent-settings-sheet';

/** `'new'` = a fresh chat, created on its first message. */
type Selection = string | 'new' | null;

function relativeDay(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

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

export default function AgentDetailPage() {
  const t = getTranslations('common').agents;
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { data: agent, isLoading } = useAgent(id);
  const { data: conversations = [] } = useWeldAgentConversations(50, id);

  const [selection, setSelection] = useState<Selection>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

  useBreadcrumbs([{ label: t.pageTitle, href: '/agents' }, { label: agent?.name ?? t.detail.untitledAgent }]);

  // Each agent opens on its latest chat, with the sheet closed.
  useEffect(() => {
    setSelection(null);
    setSettingsOpen(false);
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <Skeleton className="h-4 w-40" />
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
  let conversationId: string | null = null;
  if (selection && selection !== 'new') conversationId = selection;
  else if (selection === null) conversationId = conversations[0]?.id ?? null;

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
          {conversations.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t.detail.header.history} title={t.detail.header.history}>
                  <History className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t.detail.header.history}
                </DropdownMenuLabel>
                {conversations.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className={cn('flex flex-col items-start gap-0.5', c.id === conversationId && 'bg-accent')}
                    onSelect={() => setSelection(c.id)}
                  >
                    <span className="w-full truncate text-[13px]">{c.name}</span>
                    <span className="text-[11px] text-muted-foreground">{relativeDay(c.lastMessageAt ?? c.createdAt)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setSelection('new')}
            aria-label={t.detail.chat.newChat}
            title={t.detail.chat.newChat}
          >
            <SquarePen className="h-4 w-4" />
          </Button>
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
          conversationId={conversationId}
          onConversationCreated={setSelection}
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
