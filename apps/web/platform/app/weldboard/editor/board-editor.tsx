import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Download, Frame, Keyboard, Maximize, MoreHorizontal, Presentation, Scan, Users } from 'lucide-react';
import { canVoteOn, castVoteOp, keyAllowed, keyBetween, newId, type BoardElement, type BuiltInTemplate, type Point, type RecordRef, type RecordView } from '@weldsuite/board-engine';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { PromptDialog } from '@weldsuite/ui/components/prompt-dialog';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { formatShortcut } from '@weldsuite/ui/lib/shortcut';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { CanvasContextMenu, ContextToolbar, SelectionContextMenu, type ContextActions } from './context-toolbar';
import { CropDialog } from './crop-dialog';
import { copyAsImage, exportBoard, type ExportFormat } from './export';
import type { BoardController } from './model/board-controller';
import { pasteFragment } from './model/clipboard';
import { Interactions } from './model/interactions';
import { setMark } from './model/text-editing';
import { FacilitateButton, FacilitationPanel, votingView } from './facilitation';
import { FindBar } from './find-bar';
import { FramesPanel, Minimap, ShortcutsDialog, ZoomControls } from './navigation';
import { PresentControls, usePresentation } from './present';
import { SavedColorsContext, type SavedColors } from './swatches';
import { buildTemplate, TemplatesDialog } from './templates-dialog';
import { Toolbar, UndoRedo } from './toolbar';
import { Divider, ScrollFade } from './ui';
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
  /** The person's saved colours (their preferences); absent, they are kept while the board is open (the preview). */
  savedColors?: SavedColors;
  /** Extra items for the board's menu (versions, save as template). */
  menuExtra?: ReactNode;
  /** Bottom-centre facilitation controls (timer, voting, reactions). */
  facilitation?: ReactNode;
  record?: (ref: RecordRef) => RecordView | null;
  recordVersion?: number;
  onRecords?: () => void;
  /** Bottom centre of the board: the AI island. */
  island?: ReactNode;
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
 * The canvas behind a board without a background of its own. In dark mode a
 * dimmer neutral, so the board doesn't glare next to the dark app around it;
 * still light, because what is on boards (black text and lines, white shapes,
 * pale stickies) is made for a light board.
 */
const CANVAS_LIGHT = '#f7f8fa';
const CANVAS_DIM = '#dcdfe4';

/** Where the person's view settings (grid, board map, authors) are kept between visits. */
const VIEW_KEY = 'weldboard:view';

interface ViewSettings {
  grid: boolean;
  minimap: boolean;
  authors: boolean;
}

function readView(): Partial<ViewSettings> {
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    return raw ? (JSON.parse(raw) as Partial<ViewSettings>) : {};
  } catch {
    return {};
  }
}

function saveView(view: ViewSettings): void {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Storage blocked or full: the settings last this visit only.
  }
}

/** The person's view settings (grid, board map, authors), kept from one visit to the next. */
function useViewSettings(c: BoardController) {
  const [minimap, setMinimap] = useState(() => readView().minimap ?? false);
  useEffect(() => {
    const view = readView();
    c.showGrid = view.grid ?? c.showGrid;
    c.showAuthors = view.authors ?? c.showAuthors;
    c.changed();
  }, [c]);
  const setView = (patch: Partial<ViewSettings>) => {
    const next = { grid: patch.grid ?? c.showGrid, authors: patch.authors ?? c.showAuthors, minimap: patch.minimap ?? minimap };
    c.showGrid = next.grid;
    c.showAuthors = next.authors;
    setMinimap(next.minimap);
    saveView(next);
    c.changed();
  };
  return { minimap, setView };
}

/** An element's width, kept current as it changes; `initial` until it is measured. */
function useWidth(ref: RefObject<HTMLElement | null>, initial: number): number {
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Names the browser tab after the board while it is open. */
function useDocumentTitle(name: string | undefined): void {
  useEffect(() => {
    if (!name) return;
    const previous = document.title;
    document.title = name;
    return () => {
      document.title = previous;
    };
  }, [name]);
}

/** The editor's box: in the page, or over everything while presenting. */
function editorRootClass(presenting: boolean): string {
  return cn('flex min-h-0 w-full flex-col overflow-hidden', presenting ? 'fixed inset-0 z-50 h-dvh bg-background' : 'h-full');
}

/** Where the board map sits: above the AI button where the canvas is too narrow for both side by side. */
function minimapPlace(canvasWidth: number): string {
  return canvasWidth < 760 ? 'bottom-14' : 'bottom-3';
}

/** 'hidden' unless `show`: for what the header shows in one place or the other. */
function shownIf(show: boolean): string | undefined {
  return show ? undefined : 'hidden';
}

/**
 * The canvas colour behind a board without a background of its own, which
 * follows the app's theme and is handed to the controller for exports.
 */
function useCanvasBackground(c: BoardController): string {
  const { resolvedTheme } = useTheme();
  const themed = resolvedTheme === 'dark' ? CANVAS_DIM : CANVAS_LIGHT;
  useEffect(() => {
    c.canvasBackground = themed;
    c.changed(false);
  }, [c, themed]);
  return c.board.props.background ?? themed;
}

/** Opens a link from the board in a new tab: web and mail links only. */
function openSafeLink(url: string | undefined): void {
  if (url && /^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Presenting goes full screen (above the app and the browser's own bars) where
 * the browser allows it, and leaving full screen (Esc) stops presenting too.
 * Without full screen (not allowed in a frame) the slides still cover the app:
 * the page's main area is its own layer under the app's rail, so it is lifted
 * above it while presenting.
 */
function usePresentingLayer(root: RefObject<HTMLElement | null>, presenting: boolean, stop: () => void): void {
  useEffect(() => {
    if (!presenting) return;
    const el = root.current;
    if (el && document.fullscreenEnabled && !document.fullscreenElement) el.requestFullscreen?.().catch(() => undefined);
    const layer = el?.closest('main');
    const zIndex = layer?.style.zIndex ?? '';
    if (layer) layer.style.zIndex = '60';
    const onChange = () => {
      if (!document.fullscreenElement) stop();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (layer) layer.style.zIndex = zIndex;
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, [root, presenting, stop]);
}

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
  const { minimap, setView } = useViewSettings(c);
  // Where the right-click menu is open (canvas pixels), or null.
  const [menuAt, setMenuAt] = useState<Point | null>(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);
  // The board's own menu, on a right-click where nothing is.
  const [canvasMenuAt, setCanvasMenuAt] = useState<Point | null>(null);
  // The header's own width decides what fits in it (the window's says nothing about a side panel or the app's sidebar).
  const header = useRef<HTMLDivElement>(null);
  const headerWidth = useWidth(header, 1024);
  // The board's own width (less the side panel when one is open) decides where the map fits.
  const canvasBox = useRef<HTMLDivElement>(null);
  const canvasWidth = useWidth(canvasBox, 1024);
  /** Room for Facilitate, Present and Export beside Share: below this they move into the ⋯ menu. */
  const roomy = headerWidth >= 600;
  /** The editor's own panel on the right; one at a time. */
  const [sidePanel, setSidePanel] = useState<'frames' | 'facilitate' | null>(null);
  const togglePanel = (next: 'frames' | 'facilitate') => setSidePanel((open) => (open === next ? null : next));
  const [sessionColors, setSessionColors] = useState<string[]>([]);
  const savedColors = props.savedColors ?? { colors: sessionColors, onChange: setSessionColors };
  const [shortcuts, setShortcuts] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [finding, setFinding] = useState(false);
  const [cropping, setCropping] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [altFor, setAltFor] = useState<string | null>(null);
  // The ⋯ menu on a phone: its main list, or the export choices swapped in.
  const [moreView, setMoreView] = useState<'main' | 'export'>('main');
  const moreMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The item that swapped the list is gone: keep the keyboard in the menu.
    moreMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [moreView]);
  const imageAt = useRef<Point | null>(null);
  const presentation = usePresentation(c);
  const canvasBackground = useCanvasBackground(c);
  useDocumentTitle(props.name);
  // Renaming starts with the whole name selected, so typing replaces it.
  const nameInput = useRef<HTMLInputElement>(null);
  const renamingBoard = nameDraft !== null;
  useEffect(() => {
    if (!renamingBoard) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [renamingBoard]);
  // Votes and fading come from the board's voting round, unless the page says otherwise.
  const voting = votingView(c.board, c.options.userId);
  const propsRef = useRef(props);
  propsRef.current = props;
  const strings = useRef(te);
  strings.current = te;

  useEffect(() => {
    ia.onRenameFrame = (id) => setRenaming(id);
    ia.onComment = (id) => propsRef.current.onComment?.(id);
    ia.onVote = (el, take) => {
      // During an open round a click on something that can be voted on is a vote, not a selection.
      if ((c.readOnly && !c.canComment) || !canVoteOn(c.board.props.voting, el)) return false;
      const op = castVoteOp(c.board, c.options.userId, el.id, take);
      if (op) c.apply(op, { comment: true });
      else if (!take) toast.info(strings.current.voting.noneLeft);
      return true;
    };
    ia.onOpenLink = openSafeLink;
    ia.onOpen = (el) => {
      if (el.type === 'link') {
        openSafeLink(el.link);
        return;
      }
      if (el.src) void propsRef.current.loadImage(el.src).then((url) => url && window.open(url, '_blank', 'noopener,noreferrer'));
    };
    propsRef.current.onInteractions?.(ia);
  }, [c, ia]);

  useEffect(() => {
    props.onPresentingChange?.(presentation.presenting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation.presenting]);

  const root = useRef<HTMLDivElement>(null);
  usePresentingLayer(root, presentation.presenting, presentation.stop);

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

  const openLink = () => setLinkDraft(c.selected[0]?.link ?? '');

  const saveLink = (typed: string) => {
    // "example.com" is meant as a web address; only web and mail links are kept.
    const url = typed && !/^[a-z][a-z\d+.-]*:/i.test(typed) ? `https://${typed}` : typed;
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

  // Only what needs attention; a board that saved fine says nothing.
  const statusText: Partial<Record<BoardStatus, string>> = {
    reconnecting: te.status.reconnecting,
    'offline-pending': te.status.offlinePending,
    'view-only': te.status.viewOnly,
    'comment-only': te.status.commentOnly,
  };

  const togglePresenting = () => (presentation.presenting ? presentation.stop() : present());
  const canFacilitate = !presentation.presenting && (!c.readOnly || c.canComment);

  const exportItems = (
    <>
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
    </>
  );

  const context: ContextActions = {
    onLink: openLink,
    onOpenLink: (url) => {
      if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
    },
    onRenameFrame: (id) => setRenaming(id),
    onPresentFrom: (id) => present(id),
    onExportSelection: () => void doExport('png', new Set(c.selection)),
    onCrop: (id) => setCropping(id),
    onAltText: (id) => setAltFor(id),
    ...props.context,
  };

  return (
    <TooltipProvider delayDuration={400}>
      <SavedColorsContext.Provider value={savedColors}>
        {/* Presenting takes the whole window: the slides, without the app around them. */}
        <div ref={root} className={editorRootClass(presentation.presenting)}>
          {/* Header */}
          <div ref={header} className={cn('flex h-[53px] shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 md:px-4', shownIf(!presentation.presenting))}>
            <div className="flex min-w-0 items-center gap-1">
              {props.back}
              {nameDraft !== null ? (
                <input
                  ref={nameInput}
                  value={nameDraft}
                  maxLength={255}
                  aria-label={te.rename}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => {
                    if (nameDraft.trim() && nameDraft.trim() !== props.name) props.onRename(nameDraft.trim());
                    setNameDraft(null);
                  }}
                  onKeyDown={(e) => {
                    // Enter that confirms an IME composition is not a save.
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setNameDraft(null);
                  }}
                  className="h-7 w-56 rounded border border-primary px-1 text-[15px] font-medium leading-6 outline-none"
                />
              ) : (
                <button
                  type="button"
                  disabled={!props.canRename}
                  onClick={() => setNameDraft(props.name)}
                  // Never squeezed away by the buttons on the right.
                  className="min-w-16 max-w-[28ch] truncate rounded px-1 text-left text-[15px] font-medium leading-6 text-foreground hover:bg-muted disabled:hover:bg-transparent"
                  title={props.canRename ? te.rename : props.name}
                >
                  {props.name}
                </button>
              )}
              {statusText[props.status] && <span className="ml-2 hidden truncate text-xs text-muted-foreground sm:inline">{statusText[props.status]}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {props.facilitation}
              {props.headerExtra}
              {canFacilitate && (
                // Without room it still shows while a timer runs or a vote is open, as just the clock or the votes left.
                <FacilitateButton idleHidden={!roomy} controller={c} open={sidePanel === 'facilitate'} onToggle={() => togglePanel('facilitate')} />
              )}
              <Button size="sm" variant="outline" className={cn('h-8', shownIf(roomy))} onClick={togglePresenting}>
                {presentation.presenting ? te.present.stop : te.present.start}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className={cn('h-8', shownIf(roomy))}>
                    {te.export.title}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{exportItems}</DropdownMenuContent>
              </DropdownMenu>
              {props.onShare && (
                <Button size="sm" className="h-8" onClick={props.onShare}>
                  {te.share}
                </Button>
              )}
              <DropdownMenu onOpenChange={(open) => !open && setMoreView('main')}>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" className="size-8" aria-label={te.actions.more}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent ref={moreMenu} align="end">
                  {moreView === 'export' ? (
                    <>
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault();
                          setMoreView('main');
                        }}
                      >
                        <ChevronLeft className="size-4" />
                        {te.export.title}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {exportItems}
                    </>
                  ) : (
                    <>
                      {/* Below a laptop width the header has room for Share only: the rest is here. */}
                      {canFacilitate && (
                        <DropdownMenuItem className={shownIf(!roomy)} onSelect={() => togglePanel('facilitate')}>
                          <Users className="size-4" />
                          {te.facilitation}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem className={shownIf(!roomy)} onSelect={togglePresenting}>
                        <Presentation className="size-4" />
                        {presentation.presenting ? te.present.stop : te.present.start}
                        <DropdownMenuShortcut>F5</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={shownIf(!roomy)}
                        onSelect={(e) => {
                          e.preventDefault();
                          setMoreView('export');
                        }}
                      >
                        <Download className="size-4" />
                        {te.export.title}
                        <ChevronRight className="ml-auto size-4" />
                      </DropdownMenuItem>
                      <DropdownMenuSeparator className={shownIf(!roomy)} />
                      <DropdownMenuItem onSelect={() => togglePanel('frames')}>
                        <Frame className="size-4" />
                        {te.frames.title}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => c.zoomToFit()}>
                        <Maximize className="size-4" />
                        {te.zoom.fit}
                        <DropdownMenuShortcut>{formatShortcut(['shift', '1'])}</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={c.selection.size === 0} onSelect={() => c.zoomToSelection()}>
                        <Scan className="size-4" />
                        {te.zoom.selection}
                        <DropdownMenuShortcut>{formatShortcut(['shift', '2'])}</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem checked={c.showGrid} onCheckedChange={(v) => setView({ grid: !!v })}>
                        {te.zoom.grid}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem checked={minimap} onCheckedChange={(v) => setView({ minimap: !!v })}>
                        {te.zoom.minimap}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuCheckboxItem checked={c.showAuthors} onCheckedChange={(v) => setView({ authors: !!v })}>
                        {te.showAuthors}
                      </DropdownMenuCheckboxItem>
                      {props.menuExtra}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setShortcuts(true)}>
                        <Keyboard className="size-4" />
                        {te.shortcuts.open}
                        <DropdownMenuShortcut>?</DropdownMenuShortcut>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="@container relative flex min-h-0 flex-1">
            {/* The board: its tool row over the canvas, both as wide as the board (the side panel sits beside them). */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Tools */}
              {!presentation.presenting && (
                <div className="flex h-12 shrink-0 items-center border-b bg-muted/30 px-2">
                  {/* The tools scroll on a narrow window; zoom stays put on the right. */}
                  <ScrollFade outerClassName="flex-1 items-center" className="gap-0.5">
                    <UndoRedo controller={c} />
                    <Divider />
                    <Toolbar controller={c} onImage={() => {
                      imageAt.current = c.center();
                      imagePicker.current?.click();
                    }} onFile={props.uploadFile ? () => {
                      imageAt.current = c.center();
                      filePicker.current?.click();
                    } : undefined} onTemplates={() => setTemplates(true)} onRecords={props.onRecords} />
                  </ScrollFade>
                  <ZoomControls controller={c} />
                </div>
              )}
              <div ref={canvasBox} className="relative min-h-0 min-w-0 flex-1 overflow-hidden" style={{ backgroundColor: canvasBackground }}>
                <BoardCanvas
                  controller={c}
                  interactions={ia}
                  loadImage={props.loadImage}
                  record={props.record}
                  recordVersion={props.recordVersion}
                  onFiles={(files, at) => void insertImages(files, at)}
                  onPasteUrl={(url, at) => void pasteUrl(url, at)}
                  keyActions={{ openShortcuts: () => setShortcuts(true), openLink, openFind: () => setFinding(true), togglePresent: togglePresenting }}
                  votes={props.votes ?? voting.votes}
                  commentCounts={props.commentCounts}
                  activeComment={props.activeComment}
                  faded={props.faded ?? voting.faded}
                  renaming={renaming}
                  onRenamed={(id, name) => {
                    setRenaming(null);
                    if (name !== null && name !== c.board.get(id)?.name) c.apply({ type: 'set', id, patch: { name: name.slice(0, 200) } });
                  }}
                  labels={{ renameFrame: te.renameFrame, board: te.canvas }}
                  onContextMenu={(screen) => {
                    const kind = presentation.presenting ? null : ia.contextMenu(screen);
                    setMenuAt(kind === 'selection' ? screen : null);
                    setCanvasMenuAt(kind === 'canvas' ? screen : null);
                  }}
                />

                {props.banner && <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">{props.banner}</div>}
                {finding && (
                  <div className="pointer-events-none absolute inset-x-0 top-16 z-30 flex justify-center">
                    <FindBar controller={c} onClose={() => setFinding(false)} />
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
                <SelectionContextMenu controller={c} actions={context} at={menuAt} onClose={closeMenu} />
                <CanvasContextMenu controller={c} at={canvasMenuAt} onClose={() => setCanvasMenuAt(null)} />

                {/* Bottom centre: the AI island, or the presenting controls */}
                {props.island && !presentation.presenting && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">{props.island}</div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center gap-2">
                  <PresentControls presentation={presentation} />
                </div>

                {/* Bottom right: map */}
                {minimap && !presentation.presenting && (
                  // On a narrow board it sits above the AI button rather than over it.
                  <div className={cn('pointer-events-none absolute right-3 z-20', minimapPlace(canvasWidth))}>
                    <Minimap controller={c} />
                  </div>
                )}

                {c.readOnly && !c.canComment && (
                  <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
                    <p className="rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">{te.readOnly}</p>
                  </div>
                )}
              </div>
            </div>

            {/*
              The side panel: docked beside the board, full height, and gone while nothing is open in it.
              Where the board area is narrow (a phone, or the app's sidebar taking room) it covers the board
              instead, as the board would be a sliver beside it: a container query, not the window's width.
            */}
            {!presentation.presenting && (
              <div className="flex w-80 max-w-full shrink-0 flex-col divide-y border-s bg-background empty:hidden @max-2xl:absolute @max-2xl:inset-y-0 @max-2xl:end-0 @max-2xl:z-30 @max-2xl:shadow-lg">
                {sidePanel === 'frames' && <FramesPanel controller={c} onPresent={present} onClose={() => setSidePanel(null)} />}
                {sidePanel === 'facilitate' && <FacilitationPanel controller={c} onClose={() => setSidePanel(null)} />}
                {props.panel}
              </div>
            )}
          </div>
        </div>
        <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
        <TemplatesDialog open={templates} onOpenChange={setTemplates} onPick={pickTemplate} />
        <CropDialog controller={c} element={cropping ? (c.board.get(cropping) ?? null) : null} loadImage={props.loadImage} onClose={() => setCropping(null)} />
        <PromptDialog
          open={linkDraft !== null}
          onOpenChange={(open) => !open && setLinkDraft(null)}
          title={te.style.linkTitle}
          label={te.style.linkPrompt}
          type="url"
          placeholder="https://"
          defaultValue={linkDraft ?? ''}
          allowEmpty
          onConfirm={saveLink}
        />
        <PromptDialog
          open={altFor !== null}
          onOpenChange={(open) => !open && setAltFor(null)}
          title={te.actions.altText}
          label={te.actions.altTextPrompt}
          defaultValue={(altFor && c.board.get(altFor)?.alt) || ''}
          allowEmpty
          onConfirm={(alt) => {
            if (altFor && c.board.get(altFor)) c.apply({ type: 'set', id: altFor, patch: { alt: alt.slice(0, 1000) || null } });
          }}
        />
      </SavedColorsContext.Provider>
    </TooltipProvider>
  );
}
