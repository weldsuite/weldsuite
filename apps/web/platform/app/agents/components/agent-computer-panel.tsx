'use client';

import { useState } from 'react';
import { Monitor, RefreshCw, Trash2, Globe } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { getTranslations } from '@/lib/i18n';
import {
  useAgentComputerStatus,
  useDestroyAgentComputer,
  useCloseAgentBrowser,
} from '@/hooks/queries/use-agent-queries';

interface AgentComputerPanelProps {
  agentId: string;
}

export function AgentComputerPanel({ agentId }: AgentComputerPanelProps) {
  const t = getTranslations('common').agents.detail.computer;
  const { data: status, isLoading, refetch, isFetching } = useAgentComputerStatus();
  const destroyComputer = useDestroyAgentComputer();
  const closeBrowser = useCloseAgentBrowser(agentId);
  const [message, setMessage] = useState<string | null>(null);

  const enabled = Boolean(status && 'enabled' in status && status.enabled);

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-background p-2 border border-border/50">
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-sm font-medium">{t.title}</h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-prose">{t.description}</p>
          </div>
        </div>
        <Badge variant={enabled ? 'default' : 'secondary'}>
          {isLoading ? t.statusLoading : enabled ? t.statusReady : t.statusOff}
        </Badge>
      </div>

      {status && 'sandboxId' in status && status.sandboxId ? (
        <p className="text-xs font-mono text-muted-foreground break-all">
          {t.sandboxLabel}: {String(status.sandboxId)}
        </p>
      ) : null}

      {status && 'reason' in status && status.reason ? (
        <p className="text-xs text-muted-foreground">{String(status.reason)}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isFetching}
          onClick={() => {
            setMessage(null);
            void refetch();
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} />
          {t.refresh}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={closeBrowser.isPending}
          onClick={async () => {
            try {
              await closeBrowser.mutateAsync();
              setMessage(t.browserClosed);
            } catch (err) {
              setMessage(err instanceof Error ? err.message : t.actionFailed);
            }
          }}
        >
          <Globe className="h-3.5 w-3.5 mr-1.5" />
          {t.closeBrowser}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!enabled || destroyComputer.isPending}
          onClick={async () => {
            try {
              await destroyComputer.mutateAsync();
              setMessage(t.destroyed);
              void refetch();
            } catch (err) {
              setMessage(err instanceof Error ? err.message : t.actionFailed);
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          {t.destroy}
        </Button>
      </div>

      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}

      <p className="text-[11px] text-muted-foreground leading-relaxed">{t.hint}</p>
    </div>
  );
}
