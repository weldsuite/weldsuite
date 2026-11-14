/**
 * "Summarise these sessions": AI reads up to 20 of the recordings the current
 * filter matches and groups what it finds into themes, each with an example to
 * open. Charged, so it runs only on a click, and says plainly when the wallet
 * is short.
 */

import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import type { PanelSessionsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useSummariseWeldPanelSet } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { aiFailure } from '../lib/api-errors';
import { failureText, failureVariant } from './summary-panel';

interface SetSummaryDialogProps {
  projectId: string;
  spec: PanelSessionsSpec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SetSummaryDialog({ projectId, spec, open, onOpenChange }: Readonly<SetSummaryDialogProps>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.observe.recordings.summariseSet;
  const summarise = useSummariseWeldPanelSet();
  const { reset } = summarise;
  const result = summarise.data;
  const failure = summarise.error ? aiFailure(summarise.error) : null;

  // Whichever way the dialog closes, the next opening starts clean (the filters may have changed).
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  function run() {
    summarise.mutate({ projectId, source: { type: 'sessions', spec }, limit: 20 });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
          <DialogDescription>{ts.description}</DialogDescription>
        </DialogHeader>

        {failure && (
          <InfoBanner variant={failureVariant(failure)}>
            {failureText(failure, {
              noCredits: ts.noCredits,
              noCreditsGeneric: ts.noCreditsGeneric,
              aiDisabled: ts.aiDisabled,
              noSessions: ts.noSessions,
              failed: ts.failed,
            })}
          </InfoBanner>
        )}

        {summarise.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <InlineSpinner />
            {ts.running}
          </p>
        )}

        {result && (
          <div className="grid max-h-[60vh] gap-4 overflow-y-auto" data-testid="set-summary">
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">{ts.overview}</h3>
              <p className="text-sm leading-relaxed">{result.summary.overview}</p>
              <p className="text-xs text-muted-foreground">
                {format(ts.readN, { count: result.summary.sessionsRead })} ·{' '}
                {result.cached || result.creditsCharged === 0 ? ts.cached : format(ts.credits, { credits: result.creditsCharged })}
              </p>
            </div>
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">{ts.themes}</h3>
              <ul className="grid gap-3">
                {result.summary.themes.map((theme) => (
                  <li key={theme.title} className="grid gap-1 rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{theme.title}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">{format(ts.themeSessions, { count: theme.sessionCount })}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{theme.description}</p>
                    {theme.sessionIds[0] && (
                      <div>
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/weldpanel/recordings/${encodeURIComponent(theme.sessionIds[0])}?project=${encodeURIComponent(projectId)}`}>{ts.watch}</Link>
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {ts.close}
          </Button>
          <Button type="button" disabled={summarise.isPending} onClick={run}>
            <Sparkles />
            {ts.run}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
