/**
 * The shell of the step-by-step editor: the title, a status badge, the step
 * navigation, the current step and Back / Next. Drafts and templates both use
 * it; each passes its own steps (and the step's content as children).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useUpdateSignEnvelope, type SignTarget } from '@/hooks/queries/use-weldsign-queries';

interface EditorFrameProps<S extends string> {
  /** What the title input saves to. */
  target: SignTarget;
  title: string;
  /** Accessible name of the title input ("Request title", "Template name"). */
  titleLabel: string;
  /** Whether the title can be changed. */
  editable: boolean;
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
  const index = steps.indexOf(step);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6">
        <TitleInput target={target} title={title} label={titleLabel} disabled={!editable} />
        {badge}
        <nav aria-label={te.stepsLabel} className="ml-auto flex flex-wrap items-center gap-1">
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
      </div>

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

/** The title, saved when the input loses focus or on Enter. */
function TitleInput({ target, title, label, disabled }: Readonly<{ target: SignTarget; title: string; label: string; disabled: boolean }>) {
  const update = useUpdateSignEnvelope(target);
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  // Escape blurs before setValue(title) re-renders, so commit would still see
  // the edited value; this tells it to drop the edit instead.
  const cancelled = useRef(false);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = value.trim();
    if (!next) setValue(title);
    else if (next !== title) update.mutate({ title: next });
  };

  return (
    <Input
      aria-label={label}
      value={value}
      disabled={disabled}
      maxLength={255}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setValue(title);
          e.currentTarget.blur();
        }
      }}
      className="h-9 w-full max-w-md border-transparent px-2 text-base font-semibold shadow-none hover:border-input focus-visible:border-input sm:w-80"
    />
  );
}
