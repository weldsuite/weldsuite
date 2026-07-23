import * as React from 'react';
import { Check, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';

import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';

export interface FlowStep {
  /** Short label shown in the step rail (e.g. "Open lead"). */
  title: string;
  /** Optional one-line hint shown under the header for the active step. */
  description?: string;
  /** The screen for this step. Receives a `goTo` to wire in-screen CTAs. */
  render: (api: { goNext: () => void; goTo: (index: number) => void }) => React.ReactNode;
}

export interface FlowStepperProps {
  /** Title of the whole flow (e.g. "Capture a lead → convert"). */
  title: string;
  steps: FlowStep[];
}

/**
 * Drives a clickable, multi-step product flow. A header shows the numbered
 * steps and Back / Next controls; the body renders the active step. Used by the
 * `Flows/*` stories so a reviewer can step through a journey with pre-filled
 * mock data — no backend required.
 *
 * Buttons expose accessible names ("Next step", "Previous step", "Restart") so
 * Storybook `play` functions can drive the flow programmatically.
 */
export function FlowStepper({ title, steps }: FlowStepperProps) {
  const [index, setIndex] = React.useState(0);
  const active = steps[index];
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  const goTo = React.useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(steps.length - 1, next))),
    [steps.length],
  );
  const goNext = React.useCallback(() => goTo(index + 1), [goTo, index]);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* ─── Stepper header ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{title}</p>
            {active.description ? (
              <p className="truncate text-xs text-muted-foreground">{active.description}</p>
            ) : null}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => goTo(index - 1)}
              disabled={isFirst}
              aria-label="Previous step"
            >
              <ChevronLeft className="h-4 w-4 md:mr-1" />
              <span className="hidden md:inline">Back</span>
            </Button>
            {isLast ? (
              <Button variant="outline" size="sm" onClick={() => goTo(0)} aria-label="Restart">
                <RotateCcw className="mr-1 h-4 w-4" />
                Restart
              </Button>
            ) : (
              <Button size="sm" onClick={goNext} aria-label="Next step">
                <span className="hidden md:inline">Next</span>
                <ChevronRight className="h-4 w-4 md:ml-1" />
              </Button>
            )}
          </div>
        </div>

        {/* Numbered step rail */}
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {steps.map((step, i) => {
            const done = i < index;
            const current = i === index;
            return (
              <li key={step.title} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors',
                    current
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                  aria-current={current ? 'step' : undefined}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium',
                      current && 'bg-primary text-primary-foreground',
                      done && 'bg-primary/20 text-primary',
                      !current && !done && 'bg-muted text-muted-foreground',
                    )}
                  >
                    {done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className={cn('whitespace-nowrap', current && 'font-medium')}>
                    {step.title}
                  </span>
                </button>
                {i < steps.length - 1 ? (
                  <span className="text-muted-foreground/40">/</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      {/* ─── Active step body ──────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto">{active.render({ goNext, goTo })}</div>
    </div>
  );
}
