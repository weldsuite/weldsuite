import { useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { GitFork, Lightbulb, Network, ScrollText, Shapes, StickyNote } from 'lucide-react';
import type { BoardAiAction, BoardAiInput, BoardAiResult } from '@weldsuite/app-api-client/schemas/boards';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { documentFromText } from '@/app/welddocs/store/doc-store';
import type { BoardController } from '../editor/model/board-controller';

type MakeAction = Extract<BoardAiAction, 'mindmap' | 'diagram' | 'stickies'>;
const MAKE: { action: MakeAction; icon: typeof Network }[] = [
  { action: 'mindmap', icon: Network },
  { action: 'diagram', icon: GitFork },
  { action: 'stickies', icon: StickyNote },
];

/** Waits (briefly) for elements the server made to arrive over the room socket, then shows them. */
function reveal(c: BoardController, ids: string[]): void {
  if (!ids.length) return;
  const started = Date.now();
  const tick = () => {
    if (ids.some((id) => c.board.get(id))) {
      c.select(ids.filter((id) => c.board.get(id)));
      c.zoomToSelection();
      return;
    }
    if (Date.now() - started < 4000) window.setTimeout(tick, 100);
  };
  tick();
}

/**
 * The board's AI: make a mind map, a flowchart or sticky notes from a prompt,
 * or work on the selection (group by theme, more ideas), or summarise the
 * selection or the board into a WeldDocs document. Everything is done on the
 * server (board-api `POST /:id/ai`); what it makes arrives over the room.
 */
export function AiDialog({ controller: c, boardId, open, onOpenChange }: { controller: BoardController; boardId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const appApi = useAppApi();
  const router = useRouter();
  const { t, language } = useI18n();
  const ta = t.weldboard.editor.ai;
  const credits = useAiCreditsToast();
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [make, setMake] = useState<MakeAction>('mindmap');
  const [prompt, setPrompt] = useState('');
  const selected = c.selected.filter((el) => el.type !== 'connector' && el.type !== 'comment');
  const locale = (['en', 'nl', 'es', 'fr'] as const).find((l) => l === language);

  const run = useMutation({
    mutationFn: async (input: BoardAiInput): Promise<BoardAiResult> => (await appApi.boards.ai(boardId, input)).data,
    onSuccess: async (result, input) => {
      if (input.action !== 'summarize') {
        onOpenChange(false);
        setPrompt('');
        reveal(c, result.elementIds);
        return;
      }
      const title = result.title?.trim() || ta.summarize;
      const doc = await appApi.docs.create({ name: title.slice(0, 255), snapshot: documentFromText(`${title}.md`, result.text ?? '') });
      onOpenChange(false);
      toast.success(ta.summaryReady, { action: { label: ta.openSummary, onClick: () => router.push(`/welddocs/${doc.data.id}`) } });
    },
    onError: (err) => {
      if (!credits(err)) toast.error(ta.failed);
    },
  });
  const send = (action: BoardAiAction) =>
    run.mutate({
      action,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(action === 'mindmap' || action === 'diagram' || action === 'stickies' ? { at: c.center() } : { elementIds: selected.map((el) => el.id).slice(0, 500) }),
      ...(locale ? { locale } : {}),
    });

  return (
    <Dialog open={open} onOpenChange={(next) => !run.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{ta.title}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={ta.prompt}>
          {MAKE.map(({ action, icon: Icon }) => (
            <button
              key={action}
              type="button"
              role="radio"
              aria-checked={make === action}
              onClick={() => setMake(action)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-xs',
                make === action ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              <Icon className="size-5" />
              {ta[action]}
            </button>
          ))}
        </div>
        <Textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) send(make);
          }}
          placeholder={ta.examples[make]}
          aria-label={ta.prompt}
          rows={3}
          maxLength={4000}
        />
        <div className="space-y-1 border-t pt-3">
          {!selected.length && <p className="text-xs text-muted-foreground">{ta.selectStickies}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={run.isPending || selected.length < 2} onClick={() => send('cluster')}>
              <Shapes className="mr-1.5 size-4" />
              {ta.cluster}
            </Button>
            <Button size="sm" variant="outline" disabled={run.isPending || !selected.length} onClick={() => send('ideas')}>
              <Lightbulb className="mr-1.5 size-4" />
              {ta.ideas}
            </Button>
            <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => send('summarize')}>
              <ScrollText className="mr-1.5 size-4" />
              {ta.summarize}
            </Button>
          </div>
        </div>
        <DialogFooter>
          {run.isPending && (
            <span className="mr-auto flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <InlineSpinner />
              {ta.working}
            </span>
          )}
          <Button disabled={run.isPending || !prompt.trim()} onClick={() => send(make)}>
            {ta.generate}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
