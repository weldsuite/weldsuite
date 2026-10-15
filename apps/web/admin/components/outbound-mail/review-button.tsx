'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { requestOutboundReview } from '@/actions/outbound-mail';

/** Ask mail-api for an AI review of the workspace's biggest template today. */
export function RequestReviewButton({ workspaceId, disabled }: Readonly<{ workspaceId: string; disabled?: boolean }>) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const run = () =>
    startTransition(async () => {
      const result = await requestOutboundReview(workspaceId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.queued) {
        toast.success("AI review queued for today's biggest template. A case opens here if the verdict calls for one.");
        router.refresh();
      } else {
        toast.info('Nothing to review: the ledger has no template from this workspace today.');
      }
    });

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || isPending}
      onClick={run}
      title={disabled ? 'mail-api is not configured for this console' : undefined}
    >
      <Sparkles className="h-4 w-4" />
      {isPending ? 'Queuing…' : 'Run AI review'}
    </Button>
  );
}
