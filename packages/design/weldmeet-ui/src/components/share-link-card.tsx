import { useState, type ReactNode } from 'react';
import { Check, Copy, Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from '@weldsuite/ui/components/dialog';
import { cn } from '@weldsuite/ui/lib/utils';

export interface ShareLinkCardProps {
  shareUrl: string;
  /** Slot rendered inside the Add-people dialog. When omitted, button is hidden. */
  addPeopleDialogContent?: ReactNode;
}

/**
 * The "Your meeting's ready" floating card shown in the bottom-left of the
 * meeting room when a join code is present.
 */
export function ShareLinkCard({ shareUrl, addPeopleDialogContent }: Readonly<ShareLinkCardProps>) {
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !shareUrl) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <Card
      className={cn(
        'group absolute bottom-6 left-6 z-10 w-[300px] gap-3 p-4 shadow-md',
        // Phone: span the stage and tighten up, so less of the video is covered.
        'max-md:inset-x-2 max-md:bottom-2 max-md:w-auto max-md:gap-2 max-md:p-3',
        'animate-in slide-in-from-bottom-4 fade-in duration-300',
      )}
    >
      <div className="flex items-start gap-2 mb-0.5">
        <div className="flex-1 min-w-0 space-y-1 pt-px">
          <p className="text-[15px] font-semibold leading-tight">
            Your meeting&apos;s ready
          </p>
          <p className="text-[13px] text-muted-foreground leading-snug max-md:hidden">
            Share this link to invite others.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="size-[25px] -mr-1.5 -mt-1.5 shrink-0 text-muted-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Stacked, or side by side on a phone to keep the card short. */}
      <div className="flex flex-col gap-3 max-md:flex-row max-md:gap-2">
        <div className="flex items-center gap-1 h-9 max-md:min-w-0 max-md:flex-1 rounded-md border bg-muted/40 pl-3 pr-1">
          <span className="flex-1 text-xs font-mono text-muted-foreground truncate select-all">
            {shareUrl.replace(/^https?:\/\//, '')}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={copied ? 'Copied' : 'Copy link'}
            onClick={handleCopy}
            className="size-7 shrink-0 text-muted-foreground"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>

        {addPeopleDialogContent && (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full max-md:w-auto max-md:shrink-0">
                <Plus className="size-3.5" />
                Add people
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px] p-4">
              {addPeopleDialogContent}
            </DialogContent>
          </Dialog>
        )}
      </div>
    </Card>
  );
}
