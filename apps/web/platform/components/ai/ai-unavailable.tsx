import { BotOff } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';

interface AiUnavailableProps {
  className?: string;
  /**
   * `panel` (default) — centered empty state that fills its container.
   * Use for a whole page/panel/drawer that used to be AI-driven.
   * `inline` — compact banner. Use inside a form or list row where an
   * AI-only option/step used to live.
   */
  variant?: 'panel' | 'inline';
}

/**
 * Shared placeholder shown wherever a WeldSuite AI feature used to live.
 * AI has been removed platform-wide — this renders instead of calling any
 * AI backend, so the surrounding route/panel stays mounted (no 404s).
 */
export function AiUnavailable({ className, variant = 'panel' }: AiUnavailableProps) {
  const t = getTranslations('common');

  if (variant === 'inline') {
    return (
      <Alert className={className}>
        <BotOff />
        <AlertTitle>{t.ai.unavailable.title}</AlertTitle>
        <AlertDescription>{t.ai.unavailable.body}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <BotOff className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t.ai.unavailable.title}</p>
        <p className="text-sm text-muted-foreground max-w-sm">{t.ai.unavailable.body}</p>
      </div>
    </div>
  );
}
