'use client';

import { useState } from 'react';
import { ChevronRight, Users } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AssistantMessage } from '@/components/weldagent/chat/chat-message';
import type { ThreadDelegation } from './thread';

function DelegationStep({ delegation }: Readonly<{ delegation: ThreadDelegation }>) {
  const t = getTranslations('common').agents.detail.chat.delegation;
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md py-0.5 text-left hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <Users className="h-3.5 w-3.5 shrink-0" />
        {(delegation.report === null ? t.working : t.asked).replace('{agent}', delegation.agent)}
      </button>
      {open && (
        <div className="ml-1.5 mt-1 space-y-2 border-l pl-3">
          {delegation.task && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide">{t.task}</p>
              <p className="whitespace-pre-wrap text-foreground/80">{delegation.task}</p>
            </div>
          )}
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide">{t.report}</p>
            {delegation.report?.trim() ? (
              <AssistantMessage content={delegation.report} className="text-[13px] text-foreground/80" />
            ) : (
              <p className="text-foreground/80">{t.noReport}</p>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Work the agent handed to its sub-agents in a reply, one collapsible step each. */
export function DelegationSteps({ delegations }: Readonly<{ delegations: ThreadDelegation[] }>) {
  if (delegations.length === 0) return null;
  return (
    <ul className="space-y-1 text-[13px] text-muted-foreground">
      {delegations.map((delegation, i) => (
        <DelegationStep key={`${delegation.agent}-${i}`} delegation={delegation} />
      ))}
    </ul>
  );
}
