import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Download, Frame, Keyboard, MoreHorizontal, Presentation, Users } from 'lucide-react';
import { keyAllowed, keyBetween, newId, type BoardElement, type BuiltInTemplate, type Point, type RecordRef, type RecordView } from '@weldsuite/board-engine';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { ContextToolbar, type ContextActions } from './context-toolbar';
import { CropDialog } from './crop-dialog';
import { copyAsImage, exportBoard, type ExportFormat } from './export';
import type { BoardController } from './model/board-controller';
import { pasteFragment } from './model/clipboard';
import { Interactions } from './model/interactions';
import { setMark } from './model/text-editing';
import { FindBar } from './find-bar';
import { FramesPanel, Minimap, ShortcutsDialog, ZoomControls } from './navigation';
import { PresentControls, usePresentation } from './present';
import { buildTemplate, TemplatesDialog } from './templates-dialog';
import { Toolbar, UndoRedo } from './toolbar';
import { BoardCanvas } from './view/board-canvas';

export type BoardStatus = 'saved' | 'saving' | 'reconnecting' | 'offline-pending' | 'view-only' | 'comment-only' | 'local';

export interface UploadedImage {
  src: string;
  width: number;
  height: number;
  name: string;
}

export interface UploadedFile {
  src: string;
  name: string;
  mime: string;
  size: number;
}

export interface BoardEditorProps {
  controller: BoardController;
  name: string;
  status: BoardStatus;
  canRename: boolean;
  onRename: (name: string) => void;
  /** Loads an image source for drawing (private WeldDrive files with the session). */
  loadImage: (src: string) => Promise<string | null>;
  /** Stores an image file and returns its source (WeldDrive in a workspace, inline in the preview). */
  uploadImage: (file: File) => Promise<UploadedImage | null>;
  /** Stores any other file for a file card; absent where files cannot be stored (the preview). */
  uploadFile?: (file: File) => Promise<UploadedFile | null>;
  /** A link card's preview, when the backend can fetch one. */
  unfurl?: (url: string) => Promise<{ title: string | null; description: string | null; image: string | null; siteName: string | null } | null>;
  /** Left of the share button: peers, the presenting banner. */
  headerExtra?: ReactNode;
  /** Opens the share dialog. */
  onShare?: () => void;
  /** Right-side panels (comments, versions), shown by the page. */
  panel?: ReactNode;
  /** Extra items for the board's menu (versions, save as template). */
  menuExtra?: ReactNode;
  /** Bottom-centre facilitation controls (timer, voting, reactions). */
  facilitation?: ReactNode;
  record?: (ref: RecordRef) => RecordView | null;
  recordVersion?: number;
  onRecords?: () => void;
  onAi?: () => void;
  context?: Partial<ContextActions>;
  votes?: Map<string, number>;
  commentCounts?: Map<string, number>;
  activeComment?: string | null;
  onComment?: (id: string) => void;
  faded?: ReadonlySet<string>;
  /** Called with the interactions once, for pages that need them (comments). */
  onInteractions?: (ia: Interactions) => void;
  /** Called when presenting starts or stops (the page tells the room). */
  onPresentingChange?: (presenting: boolean) => void;
  back?: ReactNode;
  /** Top-centre notice (following someone, someone presenting). */
  banner?: ReactNode;
}

const MAX_IMAGE = 640;

/**
 * The board editor: the canvas, the tools on the left, the context toolbar
 * over the selection, zoom and map in the corner, and the header with the
 * name, status, collaborators, share and export.
 */
export function BoardEditor(props: BoardEditorProps) {
  const { controller: c } = props;
  useSyncExternalStore(c.subscribe, c.getVersion);
  const { t, format } = useI18n();
  const te = t.weldboard.editor;
  const ia = useMemo(() => new Interactions(c), [c]);
  const [minimap, setMinimap] = useState(false);
  const [frames, setFrames] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [finding, setFinding] = useState(false);
  const [cropping, setCropping] = useState<string | null>(null);
  const imageAt = useRef<Point | null>(null);
  const presentation = usePresentation(c);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    ia.onRenameFrame = (id) => setRenaming(id);
    ia.onComment = (id) => propsRef.current.onComment?.(id);
    ia.onOpen = (el) => {
      if (el.type === 'link' && el.link && /^(https?:|mailto:)/i.test(el.link)) {
        window.open(el.link, '_blank', 'noopener,noreferrer');
        return;
      }
      if (el.src) void propsRef.current.loadImage(el.src).then((url) => url && window.open(url, '_blank', 'noopener,noreferrer'));
    };
    propsRef.current.onInteractions?.(ia);
  }, [ia]);

  useEffect(() => {
    props.onPresentingChange?.(presentation.presenting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation.presenting]);

  // Fit the board in view on first open.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || c.viewport.width < 10) return;
    fitted.current = true;
    if (c.board.size) c.zoomToFit();
    else c.setCamera({ x: -c.viewport.width / 2, y: -c.viewport.height / 2, zoom: 1 }, true);
  });

  /** A file card for a file that is not an image (where files can be stored). */
  const insertFileCard = async (file: File, at: Point): Promise<boolean> => {
    const upload = props.uploadFile;
    if (!upload) {
      toast.error(format(te.image.notImage, { name: file.name }));
      return false;
    }
    const pending = toast.loading(format(te.image.uploading, { name: file.name }));
    try {
      const stored = await upload(file);
      toast.dismiss(pending);
      if (!stored) {
        toast.error(format(te.image.failed, { name: file.name }));
        return false;
      }
      const el: BoardElement = {
        id: newId(),
        type: 'file',
        order: keyBetween(c.board.topOrder(null), null),
        x: at.x - 160,
        y: at.y - 44,
        w: 320,
        h: 88,
        src: stored.src,
        fileName: stored.name.slice(0, 500) || 'file',
        mime: stored.mime.slice(0, 200),
        size: stored.size,
        createdBy: c.options.userId,
        createdAt: Date.now(),
      };
      return c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
    } catch {
      toast.dismiss(pending);
      toast.error(format(te.image.failed, { name: file.name }));
      return false;
    }
  };

  const insertImages = async (files: File[], at: Point) => {
    let offset = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/') || file.type === 'image/tiff' || file.type === 'image/heic') {
        if (await insertFileCard(file, { x: at.x + offset, y: at.y + offset })) offset += 24;
        continue;
      }
      const pending = toast.loading(format(te.image.uploading, { name: file.name }));
      try {
        const img = await props.uploadImage(file);
        toast.dismiss(pending);
        if (!img) {
          toast.error(format(te.image.failed, { name: file.name }));
          continue;
        }
        const scale = Math.min(1, MAX_IMAGE / Math.max(img.width, img.height, 1));
        const w = Math.max(20, img.width * scale);
        const h = Math.max(20, img.height * scale);
        const el: BoardElement = {
          id: newId(),
          type: 'image',
          order: keyBetween(c.board.topOrder(null), null),
          x: at.x - w / 2 + offset,
          y: at.y - h / 2 + offset,
          w,
          h,
          src: img.src,
          fileName: img.name.slice(0, 500) || 'image',
          createdBy: c.options.userId,
          createdAt: Date.now(),
        };
        c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
        offset += 24;
      } catch {
        toast.dismiss(pending);
        toast.error(format(te.image.failed, { name: file.name }));
      }
    }
  };

  const pasteUrl = async (url: string, at: Point) => {
    if (/\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(url) && url.startsWith('https://')) {
      const el: BoardElement = { id: newId(), type: 'image', order: keyBetween(c.board.topOrder(null), null), x: at.x - 160, y: at.y - 120, w: 320, h: 240, src: url, createdBy: c.options.userId, createdAt: Date.now() };
      c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
      return;
    }
    const id = newId();
    const el: BoardElement = { id, type: 'link', order: keyBetween(c.board.topOrder(null), null), x: at.x - 170, y: at.y - 50, w: 340, h: 100, link: url.slice(0, 2048), title: url.slice(0, 500), createdBy: c.options.userId, createdAt: Date.now() };
    c.apply({ type: 'create', elements: [el] }, { select: [id] });
    const preview = await props.unfurl?.(url).catch(() => null);
    if (preview && c.board.get(id)) {
      const patch: Record<string, unknown> = {};
      if (preview.title) patch.title = preview.title.slice(0, 500);
      if (preview.description) patch.description = preview.description.slice(0, 5000);
      if (preview.siteName) patch.siteName = preview.siteName.slice(0, 200);
      if (preview.image?.startsWith('https://')) patch.image = preview.image.slice(0, 4096);
      if (Object.keys(patch).length) c.apply({ type: 'set', id, patch });
    }
  };

  const openLink = () => {
    const url = window.prompt(te.style.linkPrompt, c.selected[0]?.link ?? 'https://')?.trim();
    if (url === undefined) return;
    const safe = url && /^(https?:|mailto:)/i.test(url) ? url.slice(0, 2048) : null;
    if (c.editing) {
      setMark(c, 'a', safe);
      return;
    }
    c.apply({ type: 'batch', ops: c.selected.filter((e) => keyAllowed(e.type, 'link')).map((e) => ({ type: 'set' as const, id: e.id, patch: { link: safe } })) });
  };

  const pickTemplate = (tpl: BuiltInTemplate) => {
    pasteFragment(c, buildTemplate(tpl, t, () => newId()), c.center());
    c.zoomToSelection();
  };

  const doExport = async (kind: ExportFormat, only?: ReadonlySet<string>) => {
    const pending = toast.loading(format(te.export.exporting, { name: props.name }));
    try {
      const result = await exportBoard({ controller: c, name: props.name, loadImage: props.loadImage, only }, kind);
      toast.dismiss(pending);
      if (result === 'empty') toast.info(te.export.empty);
    } catch {
      toast.dismiss(pending);
      toast.error(te.export.failed);
    }
  };

  const present = (frameId?: string) => {
    if (!presentation.start(frameId)) toast.info(te.present.noFrames);
  };

  const statusText: Record<BoardStatus, string> = {
    saved: te.status.saved,
    saving: te.status.saving,
    reconnecting: te.status.reconnecting,
    'offline-pending': te.status.offlinePending,
    'view-only': te.status.viewOnly,
    'comment-only': te.status.commentOnly,
    local: te.status.local,
  };

  const context: ContextActions = {
    onLink: openLink,
    onRenameFrame: (id) => setRenaming(id),
    onPresentFrom: (id) => present(id),
    onExportSelection: () => void doExport('png', new Set(c.selection)),
    onCrop: (id) => setCropping(id),
    onAltText: (id) => {
      const alt = window.prompt(te.actions.altTextPrompt, c.board.get(id)?.alt ?? '');
      if (alt !== null) c.apply({ type: 'set', id, patch: { alt: alt.slice(0, 1000) || null } });
    },
    ...props.context,
  };

  return (
    <TooltipProvider delayDuration={400}>
      <div className="relative h-full min-h-0 w-full overflow-hidden bg-[#f7f8fa]">
        <BoardCanvas
          controller={c}
          interactions={ia}
          loadImage={props.loadImage}
          record={props.record}
          recordVersion={props.recordVersion}
          onFiles={(files, at) => void insertImages(files, at)}
          onPasteUrl={(url, at) => void pasteUrl(url, at)}
          keyActions={{ openShortcuts: () => setShortcuts(true), openLink, openFind: () => setFinding(true), togglePresent: () => (presentation.presenting ? presentation.stop() : present()) }}
          votes={props.votes}
          commentCounts={props.commentCounts}
          activeComment={props.activeComment}
          faded={props.faded}
          renaming={renaming}
          onRenamed={(id, name) => {
            setRenaming(null);
            if (name !== null && name !== c.board.get(id)?.name) c.apply({ type: 'set', id, patch: { name: name.slice(0, 200) } });
          }}
          labels={{ renameFrame: te.renameFrame, board: te.canvas }}
        />

        {/* Header */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border bg-background px-2 py-1 shadow-md">
            {props.back}
            {nameDraft !== null ? (
              <input
                autoFocus
                value={nameDraft}
                maxLength={255}
                aria-label={te.rename}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  if (nameDraft.trim() && nameDraft.trim() !== props.name) props.onRename(nameDraft.trim());
                  setNameDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setNameDraft(null);
                }}
                className="h-7 w-56 rounded border border-primary px-1.5 text-sm font-semibold outline-none"
              />
            ) : (
              <button type="button" disabled={!props.canRename} onClick={() => setNameDraft(props.name)} className="max-w-[28ch] truncate rounded px-1.5 py-0.5 text-sm font-semibold hover:bg-muted disabled:hover:bg-transparent" title={props.canRename ? te.rename : props.name}>
                {props.name}
              </button>
            )}
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">{statusText[props.status]}</span>
          </div>
          <div className="pointer-events-auto flex items-center gap-2 rounded-xl border bg-background px-2 py-1 shadow-md">
            {props.headerExtra}
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={() => (presentation.presenting ? presentation.stop() : present())}>
              <Presentation className="size-4" />
              <span className="hidden md:inline">{presentation.presenting ? te.present.stop : te.present.start}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 gap-1.5" aria-label={te.export.title}>
                  <Download className="size-4" />
                  <span className="hidden md:inline">{te.export.title}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void doExport('png')}>{te.export.png}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void doExport('svg')}>{te.export.svg}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void doExport('pdf')}>{te.export.pdf}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void doExport('pdf-frames')}>{te.export.pdfFrames}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void doExport('json')}>{te.export.json}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    void copyAsImage({ controller: c, name: props.name, loadImage: props.loadImage, only: c.selection.size ? new Set(c.selection) : undefined }).then((ok) => ok && toast.success(te.export.copied))
                  }
                >
                  {te.export.copyImage}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {props.onShare && (
              <Button size="sm" className="h-8 gap-1.5" onClick={props.onShare}>
                <Users className="size-4" />
                {te.share}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8" aria-label={te.actions.more}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setFrames((v) => !v)}>
                  <Frame className="mr-2 size-4" />
                  {te.frames.title}
                </DropdownMenuItem>
                <DropdownMenuCheckboxItem
                  checked={c.showAuthors}
                  onCheckedChange={(v) => {
                    c.showAuthors = !!v;
                    c.changed();
                  }}
                >
                  {te.showAuthors}
                </DropdownMenuCheckboxItem>
                {props.menuExtra}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setShortcuts(true)}>
                  <Keyboard className="mr-2 size-4" />
                  {te.shortcuts.open}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {props.banner && <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex justify-center">{props.banner}</div>}
        {finding && (
          <div className="pointer-events-none absolute inset-x-0 top-28 z-30 flex justify-center">
            <FindBar controller={c} onClose={() => setFinding(false)} />
          </div>
        )}

        {/* Left: tools */}
        {!presentation.presenting && (
          <div className="pointer-events-none absolute left-3 top-1/2 z-20 -translate-y-1/2">
            <Toolbar controller={c} onImage={() => {
              imageAt.current = c.center();
              imagePicker.current?.click();
            }} onFile={props.uploadFile ? () => {
              imageAt.current = c.center();
              filePicker.current?.click();
            } : undefined} onTemplates={() => setTemplates(true)} onRecords={props.onRecords} onAi={props.onAi} />
          </div>
        )}
        <input
          ref={imagePicker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void insertImages(files, imageAt.current ?? c.center());
          }}
        />

        <input
          ref={filePicker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void insertImages(files, imageAt.current ?? c.center());
          }}
        />

        {/* Context toolbar over the selection */}
        {!presentation.presenting && <ContextToolbar controller={c} actions={context} />}

        {/* Bottom left: undo/redo */}
        {!presentation.presenting && (
          <div className="pointer-events-none absolute bottom-3 left-3 z-20">
            <UndoRedo controller={c} />
          </div>
        )}

        {/* Bottom centre: presenting controls, facilitation */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center gap-2">
          <PresentControls presentation={presentation} />
          {props.facilitation}
        </div>

        {/* Bottom right: zoom, map */}
        <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
          {minimap && <Minimap controller={c} />}
          <ZoomControls controller={c} minimap={minimap} onToggleMinimap={() => setMinimap((v) => !v)} />
        </div>

        {/* Right panels */}
        <div className="pointer-events-none absolute bottom-16 right-3 top-16 z-20 flex flex-col items-end gap-2">
          {frames && <FramesPanel controller={c} onPresent={present} onClose={() => setFrames(false)} />}
          {props.panel}
        </div>

        {c.board.size === 0 && !c.readOnly && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-lg bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow-sm">{te.emptyBoard}</p>
          </div>
        )}
        {c.readOnly && !c.canComment && (
          <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center">
            <p className="rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">{te.readOnly}</p>
          </div>
        )}
      </div>
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
      <TemplatesDialog open={templates} onOpenChange={setTemplates} onPick={pickTemplate} />
      <CropDialog controller={c} element={cropping ? (c.board.get(cropping) ?? null) : null} loadImage={props.loadImage} onClose={() => setCropping(null)} />
    </TooltipProvider>
  );
}
