'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ActionDialog } from '@/components/billing/action-dialog';
import { revealOutboundSnippet, reviewOutboundCase } from '@/actions/outbound-mail';
import { reviewOptions, type OutboundCaseStatus } from '@/lib/outbound-mail';

type Review = 'confirmed' | 'dismissed';

const REVIEW_COPY: Record<Review, { button: string; title: string; description: string; submit: string; success: string }> = {
  confirmed: {
    button: 'Confirm',
    title: 'Confirm this case',
    description:
      "It was abuse. The case is closed as confirmed; change the workspace's state or limits on its page if that has not happened yet. The notes are kept with the case and in the activity log.",
    submit: 'Confirm case',
    success: 'Case confirmed',
  },
  dismissed: {
    button: 'Dismiss',
    title: 'Dismiss this case',
    description:
      "It was a false positive. The notes are kept with the case and help tune the checks. Lift any automatic restriction on the workspace's page.",
    submit: 'Dismiss case',
    success: 'Case dismissed',
  },
};

/**
 * The snippet behind an audited reveal, and the confirm / dismiss review.
 * The snippet is only fetched on request; the server records the view in the
 * activity log before it sends the text.
 */
export function CaseActions({
  caseId,
  status,
  hasSnippet,
  canWrite,
}: Readonly<{ caseId: string; status: OutboundCaseStatus; hasSnippet: boolean; canWrite: boolean }>) {
  const router = useRouter();
  const [snippet, setSnippet] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [dialog, setDialog] = useState<Review | null>(null);
  const [isPending, startTransition] = useTransition();

  const reveal = () => {
    if (snippet !== null) {
      setShown(true);
      return;
    }
    startTransition(async () => {
      const result = await revealOutboundSnippet(caseId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSnippet(result.data.snippet);
      setShown(true);
    });
  };

  if (!canWrite && !hasSnippet) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {hasSnippet &&
          canWrite &&
          (shown ? (
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={() => setShown(false)}>
              <EyeOff className="h-3.5 w-3.5" />
              Hide snippet
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={isPending} onClick={reveal}>
              <Eye className="h-3.5 w-3.5" />
              {isPending ? 'Recording…' : 'Show snippet'}
            </Button>
          ))}
        {canWrite &&
          reviewOptions(status).map((review) => (
            <Button
              key={review}
              size="sm"
              variant="outline"
              className={
                review === 'confirmed'
                  ? 'h-7 border-destructive/40 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive'
                  : 'h-7 px-2.5 text-xs'
              }
              onClick={() => setDialog(review)}
            >
              {status === 'open' ? REVIEW_COPY[review].button : `${REVIEW_COPY[review].button} instead`}
            </Button>
          ))}
        {hasSnippet && !canWrite && (
          <span className="text-xs text-muted-foreground">The snippet is customer mail; read-only accounts cannot open it.</span>
        )}
      </div>

      {shown && snippet !== null && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Normalised template text (addresses, links and names replaced). Your view is in the activity log.
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
            {snippet}
          </pre>
        </div>
      )}

      {dialog && (
        <ActionDialog
          title={REVIEW_COPY[dialog].title}
          description={REVIEW_COPY[dialog].description}
          submitLabel={REVIEW_COPY[dialog].submit}
          destructive={dialog === 'confirmed'}
          onClose={() => setDialog(null)}
          onSubmit={async (notes) => {
            const result = await reviewOutboundCase(caseId, { status: dialog, notes });
            if (result.ok) router.refresh();
            return result;
          }}
          successMessage={REVIEW_COPY[dialog].success}
        />
      )}
    </div>
  );
}
