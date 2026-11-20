/**
 * "Add questions with AI": describe what to ask, the API drafts blocks, they
 * are added to the end of the form. Hidden by the outline when the deployment
 * has no AI (503 `ai_unavailable`).
 */

import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { newBlockId, uniqueRef, type Block, type FormDefinition } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import { isAiUnavailable, useSuggestFormBlocks } from '@/hooks/queries/use-weldforms-queries';
import { markAiUnavailable } from '../../lib/ai-availability';
import { addBlock } from '../../lib/blocks';
import { useFormEditor } from '../editor-context';

/** Gives suggested blocks ids and refs no existing block uses, so adding them can never clash. */
export function adoptSuggestedBlocks(def: FormDefinition, suggested: readonly Block[]): FormDefinition {
  let next = def;
  for (const block of suggested) {
    const fresh = { ...block, id: newBlockId('b'), ref: uniqueRef(next, block.ref || block.type) } as Block;
    next = addBlock(next, fresh);
  }
  return next;
}

export function AiSuggestDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const ta = t.weldforms.ai;
  const editor = useFormEditor();
  const suggest = useSuggestFormBlocks();
  const [prompt, setPrompt] = useState('');

  async function run() {
    try {
      const result = await suggest.mutateAsync({ prompt: prompt.trim(), definition: editor.definition });
      const count = result.blocks.length;
      if (count === 0) {
        toast.info(ta.nothingSuggested);
        return;
      }
      editor.editDefinition((d) => adoptSuggestedBlocks(d, result.blocks));
      toast.success(ta.added.replace('{count}', String(count)));
      setPrompt('');
      onOpenChange(false);
    } catch (err) {
      if (isAiUnavailable(err)) {
        markAiUnavailable();
        onOpenChange(false);
        toast.info(ta.unavailable);
      } else {
        toast.error(ta.failed);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ta.suggestTitle}</DialogTitle>
          <DialogDescription>{ta.suggestDescription}</DialogDescription>
        </DialogHeader>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} maxLength={1000} placeholder={ta.suggestPlaceholder} aria-label={ta.suggestTitle} autoFocus />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={() => void run()} disabled={prompt.trim().length < 3 || suggest.isPending}>
            {suggest.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {suggest.isPending ? ta.working : ta.suggestAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
