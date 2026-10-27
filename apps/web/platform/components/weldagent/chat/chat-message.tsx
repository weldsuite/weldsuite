import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import { CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { renderChatTokens } from '@/app/weldchat/lib/render-tokens';
import { EntityMentionChip } from '@/app/weldchat/components/entity-mention-chip';

/** A message's text with the records it tags (`<@sheet:id|Budget>`) shown as chips. */
function withRecordChips(text: string): ReactNode {
  if (!text.includes('<@')) return text;
  return renderChatTokens(text, {
    renderUser: (seg, key) => <span key={key}>@{seg.displayName ?? seg.userId}</span>,
    renderEntity: (seg, key) => (
      <EntityMentionChip key={key} type={seg.entityType} id={seg.entityId} fallbackLabel={seg.label} />
    ),
  });
}

export function UserMessage({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(85%,560px)] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
        {typeof children === 'string' ? withRecordChips(children) : children}
      </div>
    </div>
  );
}

/** Agent replies read as a document: no bubble, markdown rendered. */
export function AssistantMessage({ content, className }: Readonly<{ content: string; className?: string }>) {
  if (!content.trim()) return null;
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words text-[15px] leading-relaxed text-foreground dark:prose-invert',
        'prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold',
        'prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none',
        '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <Markdown>{content}</Markdown>
    </div>
  );
}

export function TypingIndicator({ label }: Readonly<{ label?: string | null }>) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-[13px] text-muted-foreground" aria-live="polite">
      <span className="inline-flex items-center gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/40 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/40" />
      </span>
      {label && <span>{label}</span>}
    </div>
  );
}

export interface ToolStep {
  name: string;
  failed: boolean;
}

/** "create_ticket" → "Create ticket". */
export function humanizeToolName(name: string): string {
  const text = name.replace(/[_.]/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The tools a reply used, folded into one line until opened. */
export function ToolSteps({ steps }: Readonly<{ steps: ToolStep[] }>) {
  const t = getTranslations('common').agents.detail.chat;
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const failures = steps.filter((s) => s.failed).length;
  const label = (steps.length === 1 ? t.toolsUsedOne : t.toolsUsed).replace('{count}', String(steps.length));

  return (
    <div className="text-[13px] text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md py-0.5 hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
        {label}
        {failures > 0 && (
          <span className="text-destructive">· {t.toolsFailed.replace('{count}', String(failures))}</span>
        )}
      </button>
      {open && (
        <ul className="mt-1 space-y-1 border-l pl-3 ml-1.5">
          {steps.map((step, i) => (
            <li key={`${step.name}-${i}`} className="flex items-center gap-1.5">
              {step.failed ? (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              )}
              {humanizeToolName(step.name)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
