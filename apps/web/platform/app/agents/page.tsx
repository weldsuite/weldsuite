'use client';

import { useEffect } from 'react';
import { useCanAny } from '@weldsuite/permissions/react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { useRouter, useSearchParams } from '@/lib/router';
import { useAgents } from '@/hooks/queries/use-agent-queries';
import { useWeldAgentConversation } from '@/hooks/queries/use-weldagent-queries';
import { AgentOverview } from './components/agent-overview';
import { useCreateAndOpenAgent } from './hooks/use-create-agent';

/**
 * /agents is the overview of the workspace's agents. On a phone it is also the
 * list: an agent opens full screen, and back returns here.
 */
export default function AgentsPage() {
  const t = getTranslations('common').agents;
  useBreadcrumbs([{ label: t.pageTitle }]);
  const router = useRouter();
  const { data: agents = [], isLoading } = useAgents();
  const { create, isPending } = useCreateAndOpenAgent();
  const canCreate = useCanAny(['weldagent:create', 'weldagent:manage']);
  // Notification links arrive as ?conversation=<id>: open it under its agent.
  const linked = useSearchParams().get('conversation');
  const { data: conv, isSuccess: linkedResolved } = useWeldAgentConversation(linked);

  useEffect(() => {
    if (!linked || !linkedResolved) return;
    // Agent chats are one continuous chat per person: open the agent.
    if (conv?.agentId) router.replace(`/agents/${conv.agentId}`);
    else if (conv) router.replace(`/new-chat?conversation=${encodeURIComponent(linked)}`);
    else router.replace('/agents');
  }, [conv, linked, linkedResolved, router]);

  return (
    <AgentOverview
      agents={agents}
      // A notification link is being resolved: show the loading state, not a flash of the overview.
      loading={isLoading || (Boolean(linked) && !linkedResolved)}
      creating={isPending}
      canCreate={canCreate}
      onCreate={() => void create()}
    />
  );
}
