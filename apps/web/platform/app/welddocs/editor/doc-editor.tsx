import { useMemo, useRef, useSyncExternalStore } from 'react';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { DocHeader, type DocStatus } from '../doc/doc-chrome';
import { CommentsPanel, type Person } from './comments-panel';
import { DocDialogs } from './dialogs';
import { FindBar } from './find-bar';
import { Menubar } from './menubar';
import type { DocController } from './model/doc-controller';
import { Outline } from './outline';
import { PrintView } from './print-view';
import { Ruler } from './ruler';
import { Toolbar } from './toolbar';
import { PageView } from './view/page-view';

/**
 * The document editor, laid out like Google Docs: name and menus, the
 * toolbar, the ruler, the outline on the left and the pages, and a status
 * line with the page and word count.
 */
export function DocEditor({
  controller,
  name,
  status,
  canRename,
  onRename,
  headerExtra,
  people = [],
  versionsPanel,
}: {
  controller: DocController;
  name: string;
  status: DocStatus;
  canRename: boolean;
  onRename: (name: string) => void;
  /** Right side of the header (peers, share). */
  headerExtra?: React.ReactNode;
  /** Who can be @mentioned in comments. */
  people?: Person[];
  /** The version history panel, shown while the controller has it open. */
  versionsPanel?: React.ReactNode;
}) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <DocHeader name={name} canRename={canRename} onRename={onRename} status={status} menubar={<Menubar controller={controller} name={name} />}>
          {headerExtra}
        </DocHeader>
        <Toolbar controller={controller} />
        {controller.showRuler && !controller.doc.props.pageless && <Ruler controller={controller} scrollRef={scrollRef} />}
        <div className="flex min-h-0 flex-1">
          {controller.showOutline && <Outline controller={controller} />}
          <div className="relative min-w-0 flex-1">
            <div ref={scrollRef} className="absolute inset-0 overflow-auto bg-muted/60">
              <PageView controller={controller} scrollRef={scrollRef} />
            </div>
            {controller.find && <FindBar controller={controller} />}
          </div>
          {controller.showVersions && versionsPanel}
          {!controller.showVersions && controller.showComments && (controller.draft || controller.threads().length > 0) && <CommentsPanel controller={controller} people={people} />}
        </div>
        <StatusLine controller={controller} />
      </div>
      <DocDialogs controller={controller} />
      {controller.printing && <PrintView controller={controller} />}
    </TooltipProvider>
  );
}

function StatusLine({ controller }: { controller: DocController }) {
  const { t, format } = useI18n();
  const te = t.welddocs.editor;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const words = useMemo(() => controller.stats().words, [controller.contentVersion]);
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t px-3 text-xs text-muted-foreground">
      <span>{format(te.page, { page: controller.caretPage() + 1, pages: controller.pages.length })}</span>
      <button type="button" className="hover:text-foreground" onClick={() => controller.openDialog('wordCount')}>
        {words === 1 ? te.oneWord : format(te.words, { count: words.toLocaleString() })}
      </button>
    </div>
  );
}
