'use client';

import { useState } from 'react';
import { ChevronDown, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import {
  useAgentApprovals,
  useDecideAgentApproval,
  type AgentApproval,
} from '@/hooks/queries/use-agent-parity-queries';
import { humanizeToolName } from '@/components/weldagent/chat/chat-message';
import { humanizeKey } from './labels';

function argValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ApprovalRow({
  approval,
  deciding,
  onDecide,
}: Readonly<{
  approval: AgentApproval;
  deciding: boolean;
  onDecide: (id: string, decision: 'approved' | 'rejected') => void;
}>) {
  const t = getTranslations('common').agents.detail.approvals;
  const [open, setOpen] = useState(false);
  const entries = Object.entries(approval.args ?? {});

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="truncate">
            {t.wantsTo.replace('{action}', humanizeToolName(approval.toolName).toLowerCase())}
          </span>
          {entries.length > 0 && (
            <ChevronDown
              className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
            />
          )}
        </button>
        <div className="flex shrink-0 gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-xs"
            disabled={deciding}
            onClick={() => onDecide(approval.id, 'rejected')}
          >
            {t.reject}
          </Button>
          <Button
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={deciding}
            onClick={() => onDecide(approval.id, 'approved')}
          >
            {t.approve}
          </Button>
        </div>
      </div>
      {open && entries.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{humanizeKey(key)}</dt>
              <dd className="min-w-0 break-words text-foreground">{argValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Actions the agent parked for a human, docked above the composer. */
export function ApprovalBar({ agentId }: Readonly<{ agentId: string }>) {
  const t = getTranslations('common').agents.detail.approvals;
  const { data: approvals = [] } = useAgentApprovals(agentId);
  const decide = useDecideAgentApproval(agentId);
  const [showAll, setShowAll] = useState(false);

  if (approvals.length === 0) return null;

  const onDecide = (id: string, decision: 'approved' | 'rejected') => {
    decide.mutate(
      { id, decision },
      {
        onSuccess: (res) => {
          if (decision === 'rejected') toast.success(t.rejected);
          else if (res?.execution && !res.execution.ok) {
            toast.error(t.approvedFailed.replace('{error}', res.execution.error ?? ''));
          } else toast.success(t.approved);
        },
        onError: () => toast.error(t.failed),
      },
    );
  };

  const shown = showAll ? approvals : approvals.slice(0, 2);
  const hidden = approvals.length - shown.length;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/[0.04] divide-y divide-amber-500/15 animate-in fade-in slide-in-from-bottom-1">
      {shown.map((approval) => (
        <ApprovalRow key={approval.id} approval={approval} deciding={decide.isPending} onDecide={onDecide} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {t.more.replace('{count}', String(hidden))}
        </button>
      )}
    </div>
  );
}
