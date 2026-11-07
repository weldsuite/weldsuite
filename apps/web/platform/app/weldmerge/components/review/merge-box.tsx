import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { MERGE_METHODS, type MergeMethod } from '@weldsuite/app-api-client/schemas/weldmerge-review';
import type { MergePullRequestDetailDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useI18n } from '@/lib/i18n/provider';
import { fill } from '../../lib/format';

interface MergeBoxProps {
  pullRequest: MergePullRequestDetailDto;
  merging: boolean;
  /** Resolves when merged; rejects (after reporting) when the provider refused. */
  onMerge: (input: { method: MergeMethod; commitTitle?: string; commitMessage?: string }) => Promise<void>;
}

/** Why the pull request cannot be merged right now, or null when it can. Failing checks do not block, they ask for confirmation. */
export function mergeBlockedReason(pr: Pick<MergePullRequestDetailDto, 'state' | 'draft'>, labels: { draft: string; closed: string; merged: string }): string | null {
  if (pr.state === 'merged') return labels.merged;
  if (pr.state === 'closed') return labels.closed;
  if (pr.draft) return labels.draft;
  return null;
}

/** Merge method, commit text for a squash, and the merge button behind a confirmation. */
export function MergeBox({ pullRequest, merging, onMerge }: Readonly<MergeBoxProps>) {
  const { t } = useI18n();
  const tg = t.weldmerge.reviewing.merge;
  const [method, setMethod] = useState<MergeMethod>('merge');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);

  const blocked = mergeBlockedReason(pullRequest, tg.disabled);
  const failing = pullRequest.checksStatus === 'failure';

  const confirm = async () => {
    try {
      await onMerge({
        method,
        ...(method === 'squash' && title.trim() ? { commitTitle: title.trim() } : {}),
        ...(method === 'squash' && message.trim() ? { commitMessage: message } : {}),
      });
      setConfirming(false);
    } catch {
      setConfirming(false);
    }
  };

  return (
    <SectionCard title={tg.button}>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="merge-method">{tg.method}</Label>
          <Select value={method} onValueChange={(value) => setMethod(value as MergeMethod)} disabled={blocked !== null}>
            <SelectTrigger id="merge-method" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MERGE_METHODS.map((value) => (
                <SelectItem key={value} value={value}>
                  {tg.methods[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {method === 'squash' && blocked === null && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="merge-title">{tg.commitTitle}</Label>
              <Input id="merge-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={`${pullRequest.title} (#${pullRequest.number})`} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="merge-message">{tg.commitMessage}</Label>
              <Textarea id="merge-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={3} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={blocked !== null || merging} onClick={() => setConfirming(true)}>
            <GitMerge />
            {tg.button}
          </Button>
          {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={fill(tg.confirmTitle, { number: pullRequest.number })}
        description={
          <>
            {fill(tg.confirmDescription, {
              head: pullRequest.headRef ?? '',
              base: pullRequest.baseRef ?? '',
              provider: t.weldmerge.provider[pullRequest.provider],
            })}
            {failing && <span className="mt-2 block font-medium text-destructive">{tg.confirmFailingChecks}</span>}
          </>
        }
        confirmLabel={failing ? tg.confirmAnyway : tg.confirmLabel}
        variant={failing ? 'destructive' : 'default'}
        loading={merging}
        onConfirm={confirm}
      />
    </SectionCard>
  );
}
