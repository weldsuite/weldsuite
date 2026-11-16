import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useMutation } from '@tanstack/react-query';
import { EllipsisVertical, Lightbulb, ScrollText, Shapes } from 'lucide-react';
import type { BoardAiAction, BoardAiInput, BoardAiResult } from '@weldsuite/app-api-client/schemas/boards';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { AGENT_INPUT_ICON_BUTTON } from '@/components/weldagent/agent-chat-input';
import { AGENT_ISLAND_TEXT_BUTTON, AgentIsland, AgentIslandIdeas, type AgentIslandHandle } from '@/components/weldagent/agent-island';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { documentFromText } from '@/app/welddocs/store/doc-store';
import type { BoardController } from '../editor/model/board-controller';
import type { BoardPanels } from './panels';

type MakeAction = Extract<BoardAiAction, 'mindmap' | 'diagram' | 'stickies'>;
const MAKE: MakeAction[] = ['mindmap', 'diagram', 'stickies'];

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
 * The board's AI, as the island at the bottom centre of the board (the mail
 * composer's, shared): make a mind map, a flowchart or sticky notes from a
 * prompt, work on the selection (group by theme, more ideas), or summarise the
 * selection or the board into a WeldDocs document. Everything is done on the
 * server (board-api `POST /:id/ai`); what it makes arrives over the room.
 */
export function BoardAiIsland({ controller: c, boardId, panels }: { controller: BoardController; boardId: string; panels: BoardPanels }) {
  const appApi = useAppApi();
  const router = useRouter();
  const { t, language } = useI18n();
  const ta = t.weldboard.editor.ai;
  const credits = useAiCreditsToast();
  useSyncExternalStore(c.subscribe, c.getVersion);
  const [make, setMake] = useState<MakeAction>('mindmap');
  const island = useRef<AgentIslandHandle>(null);
  const selected = c.selected.filter((el) => el.type !== 'connector' && el.type !== 'comment');
  const locale = (['en', 'nl', 'es', 'fr'] as const).find((l) => l === language);

  // The toolbar's AI button opens the island.
  const { ai } = useSyncExternalStore(panels.subscribe, panels.get);
  useEffect(() => {
    if (!ai) return;
    island.current?.open();
    panels.openAi(false);
  }, [ai, panels]);

  const run = useMutation({
    mutationFn: async (input: BoardAiInput): Promise<BoardAiResult> => (await appApi.boards.ai(boardId, input)).data,
    onSuccess: async (result, input) => {
      if (input.action !== 'summarize') {
        reveal(c, result.elementIds);
        return;
      }
      const title = result.title?.trim() || ta.summarize;
      const doc = await appApi.docs.create({ name: title.slice(0, 255), snapshot: documentFromText(`${title}.md`, result.text ?? '') });
      toast.success(ta.summaryReady, { action: { label: ta.openSummary, onClick: () => router.push(`/welddocs/${doc.data.id}`) } });
    },
    onError: (err) => {
      if (!credits(err)) toast.error(ta.failed);
    },
  });

  // Resolves to whether it worked, which is when the island folds back.
  const send = (action: BoardAiAction, prompt?: string): Promise<boolean> =>
    run
      .mutateAsync({
        action,
        ...(prompt ? { prompt } : {}),
        ...(MAKE.includes(action as MakeAction) ? { at: c.center() } : { elementIds: selected.map((el) => el.id).slice(0, 500) }),
        ...(locale ? { locale } : {}),
      })
      .then(
        () => true,
        () => false,
      );

  const busy = run.isPending;

  return (
    <AgentIsland
      ref={island}
      label={ta.open}
      placeholder={ta.placeholders[make]}
      busy={busy}
      testIdPrefix="weldboard"
      onSubmit={(prompt) => send(make, prompt)}
      startActions={(controls) => (
        <>
          <AgentIslandIdeas controls={controls} label={ta.ideasLabel} ideas={ta.promptIdeas[make]} disabled={busy} />
          <DropdownMenu {...controls.menu('make')}>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" disabled={busy} aria-label={ta.makeLabel} title={ta.makeLabel} className={AGENT_ISLAND_TEXT_BUTTON}>
                {ta[make]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56" onCloseAutoFocus={controls.backToPrompt}>
              <DropdownMenuLabel>{ta.makeLabel}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={make} onValueChange={(value) => setMake(value as MakeAction)}>
                {MAKE.map((action) => (
                  <DropdownMenuRadioItem key={action} value={action}>
                    {ta[action]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      endActions={(controls) => (
        <DropdownMenu {...controls.menu('selection')}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={ta.selectionLabel} title={ta.selectionLabel} className={AGENT_INPUT_ICON_BUTTON}>
              <EllipsisVertical className="h-[18px] w-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-64" onCloseAutoFocus={controls.backToPrompt}>
            <DropdownMenuLabel>{selected.length ? ta.selectionLabel : ta.selectStickies}</DropdownMenuLabel>
            <DropdownMenuItem disabled={selected.length < 2} onSelect={() => void send('cluster')}>
              <Shapes className="mr-2 size-4" />
              {ta.cluster}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!selected.length} onSelect={() => void send('ideas')}>
              <Lightbulb className="mr-2 size-4" />
              {ta.ideas}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void send('summarize')}>
              <ScrollText className="mr-2 size-4" />
              {ta.summarize}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    />
  );
}
