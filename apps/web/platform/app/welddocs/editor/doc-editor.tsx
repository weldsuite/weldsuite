import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { DocHeader, type DocStatus } from '../doc/doc-chrome';
import { SuggestionsPanel } from './comments-panel';
import { DocDialogs } from './dialogs';
import { FindBar } from './find-bar';
import { Menubar } from './menubar';
import type { DocController } from './model/doc-controller';
import { Outline } from './outline';
import { PrintView } from './print-view';
import { Ruler } from './ruler';
import { ModeMenu, Toolbar } from './toolbar';
import { PageView } from './view/page-view';
import { DocScrollContext, type DocScroll } from './view/scroll-context';

/**
 * The document editor: the name with the mode and Share on the right, the
 * toolbar with the menus at its end, the ruler, and the outline on the left
 * and the pages. The word count is under Tools.
 */
export function DocEditor({
  controller,
  name,
  status,
  canRename,
  onRename,
  headerExtra,
  share,
  commentsPanel,
  versionsPanel,
}: {
  controller: DocController;
  name: string;
  status: DocStatus;
  canRename: boolean;
  onRename: (name: string) => void;
  /** Right side of the header, before the mode menu (peers). */
  headerExtra?: React.ReactNode;
  /** The share button, right of the mode menu. */
  share?: React.ReactNode;
  /** The comments beside the pages (a workspace document's; without it only suggestions show). */
  commentsPanel?: React.ReactNode;
  /** The version history panel, shown while the controller has it open. */
  versionsPanel?: React.ReactNode;
}) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [roomBelow, setRoomBelow] = useState(0);
  const scroll = useMemo<DocScroll>(() => ({ scrollRef, setRoomBelow }), []);

  return (
    <DocScrollContext.Provider value={scroll}>
      <TooltipProvider delayDuration={400}>
        <div className="flex h-full min-h-0 flex-col bg-background">
          <DocHeader name={name} canRename={canRename} onRename={onRename} status={status}>
            {headerExtra}
            <ModeMenu controller={controller} />
            {share}
          </DocHeader>
          <Toolbar controller={controller} end={<Menubar controller={controller} name={name} />} />
          {controller.showRuler && !controller.doc.props.pageless && <Ruler controller={controller} scrollRef={scrollRef} />}
          <div className="flex min-h-0 flex-1">
            {controller.showOutline && <Outline controller={controller} />}
            <div className="relative min-w-0 flex-1">
              <div ref={scrollRef} className="absolute inset-0 overflow-auto bg-muted/60">
                <PageView controller={controller} scrollRef={scrollRef} />
                {roomBelow > 0 && <div aria-hidden style={{ height: roomBelow }} />}
              </div>
              {controller.find && <FindBar controller={controller} />}
            </div>
            {controller.showVersions && versionsPanel}
            {!controller.showVersions && controller.showComments && (controller.draft || controller.threads().length > 0) && (commentsPanel ?? <SuggestionsPanel controller={controller} />)}
          </div>
        </div>
        <DocDialogs controller={controller} />
        {controller.printing && <PrintView controller={controller} />}
      </TooltipProvider>
    </DocScrollContext.Provider>
  );
}
