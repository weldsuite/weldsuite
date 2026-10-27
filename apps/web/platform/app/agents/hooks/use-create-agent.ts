'use client';

import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import type { WorkspaceAgent } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { useRouter } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { useAppApi } from '@/lib/api/use-app-api';
import { useAgents, useCreateAgent } from '@/hooks/queries/use-agent-queries';
import { agentNeedsSetup } from '../components/agent-state';

/** How many unfinished drafts are looked at before a new agent is created. */
const MAX_DRAFTS_CHECKED = 3;

/**
 * The user's own drafts that still need their setup interview, newest first.
 * An agent someone else started is not theirs to pick up.
 */
export function draftCandidates(agents: WorkspaceAgent[], userId: string | null | undefined): WorkspaceAgent[] {
  return agents
    .filter((a) => a.status === 'draft' && agentNeedsSetup(a) && (!userId || !a.createdBy || a.createdBy === userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_DRAFTS_CHECKED);
}

/**
 * The first draft nobody has talked to yet, so "New agent" opens it instead of
 * leaving another empty "Untitled agent" behind.
 */
export async function findUntouchedDraft(
  drafts: WorkspaceAgent[],
  messageCount: (agentId: string) => Promise<number>,
): Promise<WorkspaceAgent | null> {
  for (const draft of drafts) {
    if ((await messageCount(draft.id)) === 0) return draft;
  }
  return null;
}

/** "New agent": opens the user's untouched setup draft, or creates a fresh agent and opens that. */
export function useCreateAndOpenAgent() {
  const t = getTranslations('common').agents;
  const router = useRouter();
  const { userId } = useAuth();
  const { weldAgent } = useAppApi();
  const { data: agents = [] } = useAgents();
  const createAgent = useCreateAgent();
  const [looking, setLooking] = useState(false);

  const messageCount = async (agentId: string): Promise<number> => {
    const res = await weldAgent.listConversations(5, { agentId });
    return (res.data ?? []).reduce((sum, conversation) => sum + (conversation.messageCount ?? 0), 0);
  };

  const create = async () => {
    if (createAgent.isPending || looking) return;
    setLooking(true);
    try {
      const draft = await findUntouchedDraft(draftCandidates(agents, userId), messageCount).catch(() => null);
      if (draft) {
        router.push(`/agents/${draft.id}`);
        return;
      }
      const res = await createAgent.mutateAsync({ name: t.detail.untitledAgent });
      if (res.data?.id) router.push(`/agents/${res.data.id}`);
    } catch {
      toast.error(t.detail.feedback.createFailed);
    } finally {
      setLooking(false);
    }
  };
  return { create, isPending: createAgent.isPending || looking };
}
