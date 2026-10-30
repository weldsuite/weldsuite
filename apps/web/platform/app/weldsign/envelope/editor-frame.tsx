/**
 * The shell of the template editor: the title, a badge, the step navigation,
 * the current step and Back / Next. `EditorHeader` is the bar on top, which a
 * request uses too.
 */

import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, ChevronLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InlineTextEditor } from '@/components/shared/inline-text-editor';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useUpdateSignEnvelope, type SignTarget } from '@/hooks/queries/use-weldsign-queries';

/**
 * The list rows of a request's side panel (documents, recipients): 43px, the
 * row menu button's 28px with 7px above and below and the divider.
 */
export const PANEL_ROW = 'py-[7px]';

/** Where the header's back button goes, and what it is called. */
export interface EditorBack {
  to: string;
  label: string;
}

interface EditorFrameProps<S extends string> {
  /** What the title saves to. */
  target: SignTarget;
  title: string;
  /** Accessible name of the title while it is edited ("Request title", "Template name"). */
  titleLabel: string;
  /** Whether the title can be changed. */
  editable: boolean;
  back: EditorBack;
  /** Next to the title: the status of a request, "Template" for a template. */
  badge: ReactNode;
  steps: readonly S[];
  stepLabels: Record<S, string>;
  step: S;
  onStepChange: (step: S) => void;
  /** A strip under the header, for example "read only". */
  banner?: ReactNode;
  /** The current step. */
  children: ReactNode;
}

export function EditorFrame<S extends string>({
  target,
  title,
  titleLabel,
  editable,
  back,
  badge,
  steps,
  stepLabels,
  step,
  onStepChange,
  banner,
  children,
}: Readonly<EditorFrameProps<S>>) {
  const { t } = useI18n();
  const te = t.weldsign.editor;
  const update = useUpdateSignEnvelope(target);
  const index = steps.indexOf(step);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader
        title={title}
        titleLabel={titleLabel}
        onRename={editable ? (next) => update.mutate({ title: next.slice(0, 255) }) : undefined}
        back={back}
        badge={badge}
      >
        <nav aria-label={te.stepsLabel} className="flex flex-wrap items-center gap-1">
          {steps.map((value, i) => (
            <button
              key={value}
              type="button"
              aria-current={step === value ? 'step' : undefined}
              onClick={() => onStepChange(value)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                step === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-xs tabular-nums',
                  i < index && 'border-primary bg-primary text-primary-foreground',
                  step === value && 'border-primary text-primary',
                )}
              >
                {i < index ? <Check className="size-3" /> : i + 1}
              </span>
              {stepLabels[value]}
            </button>
          ))}
        </nav>
      </EditorHeader>

      {banner}

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

      <div className="flex items-center justify-between border-t px-4 py-3 sm:px-6">
        <Button variant="outline" size="sm" disabled={index === 0} onClick={() => onStepChange(steps[index - 1]!)}>
          <ArrowLeft />
          {te.back}
        </Button>
        {index < steps.length - 1 && (
          <Button size="sm" onClick={() => onStepChange(steps[index + 1]!)}>
            {te.next}
            <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The bar over a request or template, as WeldDocs and WeldSheets have it: back,
 * the title (renamed in place as a task title is, when `onRename` is given),
 * its badge, and whatever goes on the right.
 */
export function EditorHeader({
  title,
  titleLabel,
  onRename,
  back,
  badge,
  children,
}: Readonly<{ title: string; titleLabel?: string; onRename?: (next: string) => void; back: EditorBack; badge: ReactNode; children?: ReactNode }>) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[53px] shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">
      <Button
        variant="ghost"
        size="icon"
        className="size-[30px] shrink-0 text-muted-foreground"
        aria-label={back.label}
        title={back.label}
        onClick={() => navigate({ to: back.to }).catch(() => undefined)}
      >
        <ChevronLeft className="!size-[18px]" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Editing shows the hover's 1px border, in blue, instead of an added focus ring. The box is
            as wide as the title, so the badge sits right after it: the editor's own negative margins
            (which would cut its text short here) give way to the wrapper's, which keeps the text
            8px from the back button. */}
        <div className="-ml-[3px] flex min-w-0 max-w-md">
          {onRename ? (
            <InlineTextEditor
              value={title}
              onSave={onRename}
              label={titleLabel}
              singleLine
              className="mx-0 text-[15px] font-medium leading-6 text-foreground focus:border-primary focus:ring-0"
            />
          ) : (
            <h1 className="truncate pl-[7px] text-[15px] font-medium leading-6 text-foreground">{title}</h1>
          )}
        </div>
        {badge}
      </div>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}
