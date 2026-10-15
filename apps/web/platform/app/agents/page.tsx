'use client';

import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { useRouter, useSearchParams } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { WeldAgentIcon } from '@/components/icons/weldagent-icon';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useWeldAgentConversation } from '@/hooks/queries/use-weldagent-queries';
import { useCreateAndOpenAgent } from './components/agent-list';

/**
 * /agents — on desktop, jump into the first agent (or offer to create one).
 * On mobile this route shows the agent list (ListDetailLayout).
 */
export default function AgentsPage() {
  const t = getTranslations('common').agents;
  useBreadcrumbs([{ label: t.pageTitle }]);
  const router = useRouter();
  const { data: agents = [], isLoading } = useAgents();
  const { create, isPending } = useCreateAndOpenAgent();
  // Notification links arrive as ?conversation=<id>: open it under its agent.
  const linked = useSearchParams().get('conversation');
  const { data: conv, isSuccess: linkedResolved } = useWeldAgentConversation(linked);

  useEffect(() => {
    if (!linked || !linkedResolved) return;
    if (conv?.agentId) router.replace(`/agents/${conv.agentId}?conversation=${encodeURIComponent(linked)}`);
    else if (conv) router.replace(`/new-chat?conversation=${encodeURIComponent(linked)}`);
    else router.replace('/agents');
  }, [conv, linked, linkedResolved, router]);

  // Redirecting on mobile would make the list unreachable.
  useEffect(() => {
    if (linked || isLoading || agents.length === 0) return;
    if (window.matchMedia('(max-width: 767px)').matches) return;
    router.replace(`/agents/${agents[0].id}`);
  }, [agents, isLoading, linked, router]);

  if (isLoading || agents.length > 0) return <div className="hidden h-full flex-1 md:block" />;

  return (
    <div className="hidden h-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center md:flex">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
        <WeldAgentIcon className="h-6 w-6" />
      </span>
      <h3 className="text-lg font-semibold">{t.list.emptyTitle}</h3>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t.list.emptyDescription}</p>
      <Button className="mt-2 gap-1.5" disabled={isPending} onClick={() => void create()}>
        <Plus className="h-4 w-4" />
        {t.list.emptyAction}
      </Button>
    </div>
  );
}
