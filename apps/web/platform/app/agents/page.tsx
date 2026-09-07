'use client';

import { useEffect } from 'react';
import { Bot } from 'lucide-react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { useAgents, useCreateAgent } from '@/hooks/queries/use-agent-queries';

/**
 * /agents — WhatsApp-style empty pane on desktop, or redirect to the first bot.
 * Mobile shows the bot list via ListDetailLayout when no detail is selected.
 */
export default function AgentsPage() {
  const t = getTranslations('common');
  useBreadcrumbs([{ label: t.agents.pageTitle }]);
  const router = useRouter();
  const { data: agents = [], isLoading } = useAgents();
  const createAgent = useCreateAgent();

  useEffect(() => {
    if (isLoading || agents.length === 0) return;
    router.replace(`/agents/${agents[0].id}`);
  }, [agents, isLoading, router]);

  const handleCreate = async () => {
    const res = await createAgent.mutateAsync({ name: t.agents.detail.untitledAgent });
    if (res.data?.id) router.push(`/agents/${res.data.id}`);
  };

  if (isLoading || agents.length > 0) {
    return (
      <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="h-full flex-1 hidden md:flex flex-col items-center justify-center text-center px-6 gap-3">
      <Bot className="h-10 w-10 text-muted-foreground" />
      <h3 className="text-[15px] font-semibold">{t.agents.list.emptyTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">
        {t.agents.list.emptyDescription}
      </p>
      <Button
        className="mt-1"
        disabled={createAgent.isPending}
        onClick={() => void handleCreate()}
      >
        {t.agents.list.emptyAction}
      </Button>
    </div>
  );
}
