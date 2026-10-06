import { useState } from 'react';
import { Check, Copy, Loader2, Radio, Square } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { formatLabel, type MeetingToolsLabels } from '../../tools/labels';
import type { MeetingLivestream } from '../../tools/use-meeting-tools';

export interface LivestreamToolProps {
  livestream: MeetingLivestream;
  labels: MeetingToolsLabels;
}

export function LivestreamTool({ livestream, labels }: LivestreamToolProps) {
  const t = labels.livestream;
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const { state, isLive, viewerCount, viewerUrl, canLivestream } = livestream;
  const starting = state === 'STARTING' || state === 'WAITING_ON_MANUAL_INGESTION';
  const stopping = state === 'STOPPING';
  const busy = pending || starting || stopping;

  const run = async (action: () => Promise<void>, failure: string) => {
    setPending(true);
    try {
      await action();
    } catch (err) {
      console.error('[WeldMeet] livestream action failed:', err);
      toast.error(failure);
    } finally {
      setPending(false);
    }
  };

  const handleCopy = async () => {
    if (!viewerUrl) return;
    try {
      await navigator.clipboard.writeText(viewerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="p-4 space-y-5">
      <p className="text-sm text-muted-foreground">{t.intro}</p>

      {isLive && (
        <div className="rounded-xl bg-muted/40 px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium text-red-500">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" aria-hidden />
              {t.live}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatLabel(t.viewers, { count: viewerCount })}
            </span>
          </div>
          {viewerUrl && (
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted-foreground">{t.viewerLink}</span>
              <div className="flex items-center gap-2">
                <a
                  href={viewerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm text-primary hover:underline"
                >
                  {viewerUrl}
                </a>
                <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? t.copied : t.copyLink}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {!canLivestream && <p className="rounded-xl bg-muted/40 px-3 py-2.5 text-sm">{t.unavailable}</p>}

      {canLivestream && !isLive && (
        <Button type="button" className="w-full" disabled={busy} onClick={() => run(livestream.start, t.startFailed)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
          {stopping ? t.stopping : busy ? t.starting : t.start}
        </Button>
      )}

      {canLivestream && isLive && (
        <Button
          type="button"
          variant="destructive"
          className="w-full"
          disabled={busy}
          onClick={() => run(livestream.stop, t.stopFailed)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
          {busy ? t.stopping : t.stop}
        </Button>
      )}
    </div>
  );
}
