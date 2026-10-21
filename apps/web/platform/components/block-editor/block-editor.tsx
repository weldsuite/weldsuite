import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { BlockNoteView } from '@blocknote/shadcn';
import {
  useCreateBlockNote,
  SuggestionMenuController,
  FloatingComposerController,
  FloatingThreadController,
} from '@blocknote/react';
import type { Block, PartialBlock } from '@blocknote/core';
import { CommentsExtension } from '@blocknote/core/comments';
import { en as blockNoteEn, es as blockNoteEs, fr as blockNoteFr, nl as blockNoteNl } from '@blocknote/core/locales';
import { undoDepth, redoDepth } from 'prosemirror-history';
import '@blocknote/shadcn/style.css';
import { cn } from '@/lib/utils';
import { useFileUpload } from '@/hooks/use-file-upload';
import { useI18n } from '@/lib/i18n/provider';
import { schema } from './schema';
import { getBlockEditorStrings, type BlockEditorStrings } from './strings';
import { SuggestionMenu } from './suggestion-menu';
import {
  filterSlashMenuItems,
  getPageLinkItems,
  getSlashMenuItems,
  PAGE_LINK_TRIGGER,
  type PageLinkSource,
} from './slash-menu';
import { useTableResizeClamp } from './use-table-resize-clamp';
import {
  Strikethrough,
  Code,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Heading1,
  Heading2,
  Heading3,
  Undo2 as Undo,
  Redo2 as Redo,
  Link as LinkIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  IndentDecrease,
  IndentIncrease,
  Baseline,
  Highlighter,
  RemoveFormatting,
  Pilcrow,
  ChevronDown,
  ChevronLeft,
  Check,
  Lightbulb,
  ListCollapse,
  SquareCode,
  MessageSquarePlus,
} from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  ColorPicker,
  ColorPickerSelection,
  ColorPickerHue,
  ColorPickerFormat,
} from '@weldsuite/ui/components/color-picker';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';

// ============================================================================
// BlockNote-based Notion-like document editor
// ============================================================================

/** Blocks bound to this editor's schema (see ./schema). */
type EditorBlock = PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>;

/** Imperative handle exposed via ref */
export interface BlockEditorHandle {
  /** Replace the entire editor content with new blocks */
  replaceContent: (blocks: EditorBlock[]) => void;
}

export interface BlockEditorProps {
  /** Initial content as BlockNote JSON blocks */
  initialContent?: EditorBlock[];
  /** Initial HTML content (will be converted to blocks) */
  initialHtml?: string;
  /** Whether the editor is editable */
  editable?: boolean;
  /** Called when content changes (debounced internally by consumer) */
  onContentChange?: (blocks: Block[]) => void;
  /** Additional class name */
  className?: string;
  /** Project ID for file uploads */
  projectId?: string;
  /** Entity ID for file uploads */
  entityId?: string;
  /** Called once the BlockNote editor is created — used to render external formatting toolbars */
  onEditorReady?: (editor: BlockNoteEditorInstance) => void;
  /**
   * Yjs collaboration. When set, the editor is created in collaborative mode
   * bound to the shared fragment, and `initialContent` is ignored (Yjs is the
   * source of truth for the live document).
   */
  collaboration?: {
    provider: unknown;
    fragment: unknown;
    user: { name: string; color: string };
  };
  /**
   * Enable inline comment threads (requires collaboration — threads live in
   * the Yjs doc). When set, the comments extension + floating composer/thread
   * controllers are wired in.
   */
  comments?: {
    threadStore: unknown;
    resolveUsers: (userIds: string[]) => Promise<unknown[]>;
  };
  /**
   * Pages this editor can create and link to. Enables the "Page" and "Link to
   * page" slash commands and the `@` page menu; leave unset where the content
   * has no pages around it.
   */
  pageLinks?: PageLinkSource;
  /**
   * Show a formatting bar above selected text (block type, colours, link,
   * bold / italic / strikethrough). `onAskAgent` adds an "Ask Agent"
   * button that hands the selected text over.
   */
  selectionToolbar?: {
    onAskAgent?: (text: string) => void;
  };
}

/** BlockNote's own UI strings (built-in slash commands, placeholders, menus) per app language. */
const BLOCKNOTE_DICTIONARIES: Record<string, typeof blockNoteEn> = {
  en: blockNoteEn,
  nl: blockNoteNl,
  es: blockNoteEs,
  fr: blockNoteFr,
};

// Uploads the editor accepts: images, plus what the video, audio and file
// blocks hold. Images keep their own, smaller size limit.
const IMAGE_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MEDIA_UPLOAD_TYPES = [
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm',
  'application/pdf', 'application/zip', 'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Opaque editor handle for external formatting toolbars */
export type BlockNoteEditorInstance = ReturnType<typeof useCreateBlockNote>;

export const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(function BlockEditor({
  initialContent,
  initialHtml,
  editable = true,
  onContentChange,
  className,
  projectId,
  entityId,
  onEditorReady,
  collaboration,
  comments,
  pageLinks,
  selectionToolbar,
}, ref) {
  const { language } = useI18n();
  const { uploadFile } = useFileUpload({
    folder: 'documents/content',
    maxFileSize: MAX_MEDIA_UPLOAD_BYTES,
    allowedTypes: [...IMAGE_UPLOAD_TYPES, ...MEDIA_UPLOAD_TYPES],
    entityType: 'project-document',
    entityId: entityId || projectId || '',
    isPublic: true,
  });

  const handleUploadFile = useCallback(
    async (file: File): Promise<string> => {
      if (IMAGE_UPLOAD_TYPES.includes(file.type) && file.size > MAX_IMAGE_UPLOAD_BYTES) {
        throw new Error('Image exceeds the upload limit');
      }
      const result = await uploadFile(file);
      // Throwing makes BlockNote show its "upload failed" state; returning an
      // empty URL would leave a broken, empty media block behind.
      if (!result?.url) throw new Error('Upload failed');
      return result.url;
    },
    [uploadFile],
  );

  // Determine initial content
  const resolvedInitialContent = useMemo(() => {
    if (initialContent && initialContent.length > 0) {
      return initialContent;
    }
    return undefined;
  }, [initialContent]);

  const editor = useCreateBlockNote(
    {
      schema,
      dictionary: BLOCKNOTE_DICTIONARIES[language] ?? blockNoteEn,
      // In collaborative mode the Yjs fragment is the source of truth, so we
      // must NOT also pass initialContent (it would conflict with sync).
      initialContent: collaboration ? undefined : resolvedInitialContent,
      uploadFile: handleUploadFile,
      ...(collaboration
        ? {
            collaboration: {
              provider: collaboration.provider,
              fragment: collaboration.fragment,
              user: collaboration.user,
            } as never,
          }
        : {}),
      ...(comments
        ? {
            extensions: [
              CommentsExtension({
                threadStore: comments.threadStore as never,
                resolveUsers: comments.resolveUsers as never,
              }),
            ],
          }
        : {}),
    },
    [resolvedInitialContent, collaboration?.fragment, comments?.threadStore],
  );

  // Expose editor to parent for external formatting toolbars
  useEffect(() => {
    onEditorReady?.(editor);
  }, [editor, onEditorReady]);

  // Keep table columns from being dragged wider than the content width
  const wrapperRef = useRef<HTMLDivElement>(null);
  useTableResizeClamp(wrapperRef);

  // Flag to suppress onChange during remote content replacement
  const isRemoteUpdateRef = useRef(false);

  // Expose imperative handle for remote content updates
  useImperativeHandle(ref, () => ({
    replaceContent: (blocks: EditorBlock[]) => {
      // Deferred out of the caller's stack: hosts call this from an effect,
      // and the React-rendered blocks (callout, embed, …) mount through
      // flushSync, which React refuses to run inside a lifecycle.
      queueMicrotask(() => {
        isRemoteUpdateRef.current = true;
        try {
          editor.replaceBlocks(editor.document, blocks);
        } finally {
          // Reset after a tick so the onChange from replaceBlocks is suppressed
          setTimeout(() => { isRemoteUpdateRef.current = false; }, 0);
        }
      });
    },
  }), [editor]);

  // Convert HTML to blocks if initialHtml is provided and no JSON content
  useEffect(() => {
    if (initialHtml && (!initialContent || initialContent.length === 0)) {
      function convert() {
        try {
          const blocks = editor.tryParseHTMLToBlocks(initialHtml!);
          if (blocks.length > 0) {
            editor.replaceBlocks(editor.document, blocks);
          }
        } catch {
          // If HTML parsing fails, leave editor empty
        }
      }
      convert();
    }
  }, [initialHtml, initialContent, editor]);

  // Switching the editor between editable and read-only makes it emit an
  // update of its own. Nothing was edited, and a host that autosaves would
  // write to a page that has just been locked (a 409 and a "failed to save"
  // toast). That update fires from BlockNoteView's effect, which can run while
  // the previous `handleChange` is still subscribed — so check the value as of
  // this render (the ref) as well as the one the callback closed over.
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const handleChange = useCallback(() => {
    if (isRemoteUpdateRef.current) return; // Skip onChange triggered by remote replaceContent
    if (!editable || !editableRef.current) return;
    if (onContentChange) {
      onContentChange(editor.document as unknown as Block[]);
    }
  }, [editable, editor, onContentChange]);

  // Watch for theme changes
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    }
    return 'light';
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      setTheme(dark ? 'dark' : 'light');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  const strings = getBlockEditorStrings();

  return (
    <div
      ref={wrapperRef}
      className={cn('block-editor-wrapper', className)}
      data-has-selection-toolbar={selectionToolbar && editable ? '' : undefined}
    >
      <BlockNoteView
        editor={editor}
        editable={editable}
        onChange={handleChange}
        theme={theme}
        // The static toolbar at the top of the document already exposes
        // every formatting action, so disable BlockNote's built-in
        // selection bubble menu — it would otherwise appear on top of
        // any text selection.
        formattingToolbar={false}
        // Disable BlockNote's default / menu — we provide our own below
        // (Notion-style commands, Lucide icons). Without this, BOTH menus
        // would register on the same trigger character and clicks on
        // our menu's items got intercepted by the default's handler.
        slashMenu={false}
        data-theming-css-variables-demo
      >
        {/* / trigger — see ./slash-menu for the command list */}
        <SuggestionMenuController
          triggerCharacter="/"
          suggestionMenuComponent={SuggestionMenu}
          getItems={(query) =>
            Promise.resolve(
              filterSlashMenuItems(getSlashMenuItems(editor, { strings, locale: language, pageLinks }), query),
            )
          }
        />
        {/* @ trigger — link to another page, where the host has pages */}
        {pageLinks ? (
          <SuggestionMenuController
            triggerCharacter={PAGE_LINK_TRIGGER}
            suggestionMenuComponent={SuggestionMenu}
            getItems={(query) =>
              Promise.resolve(getPageLinkItems(editor, pageLinks.search(query), strings.pageLinks.untitled))
            }
          />
        ) : null}
        {/* Comment threads (collaborative): floating composer when adding a
            comment on a selection, and the thread card when one is clicked. */}
        {comments ? (
          <>
            <FloatingComposerController />
            <FloatingThreadController />
          </>
        ) : null}
      </BlockNoteView>
      {selectionToolbar && editable ? (
        <SelectionToolbar editor={editor} onAskAgent={selectionToolbar.onAskAgent} />
      ) : null}
    </div>
  );
});

// ============================================================================
// Static formatting toolbar (always visible at top of editor)
// ============================================================================

type BasicStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
type HeadingLevel = 1 | 2 | 3;
/** Block types the static toolbar's block menu can switch to. */
type StaticBlockType =
  | 'paragraph' | 'heading' | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote'
  | 'toggleListItem' | 'codeBlock' | 'callout';
type ColorLabelKey = keyof BlockEditorStrings['toolbar']['colors'];
type TextAlignment = 'left' | 'center' | 'right' | 'justify';

const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: '', label: 'Default' },

  // Sans-serif
  { value: 'Inter, ui-sans-serif, system-ui, sans-serif', label: 'Inter' },
  { value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', label: 'System UI' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: '"Arial Black", sans-serif', label: 'Arial Black' },
  { value: '"Arial Narrow", Arial, sans-serif', label: 'Arial Narrow' },
  { value: 'Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { value: '"Helvetica Neue", Helvetica, sans-serif', label: 'Helvetica Neue' },
  { value: '"Segoe UI", Tahoma, sans-serif', label: 'Segoe UI' },
  { value: 'Roboto, sans-serif', label: 'Roboto' },
  { value: '"Roboto Condensed", sans-serif', label: 'Roboto Condensed' },
  { value: 'Tahoma, sans-serif', label: 'Tahoma' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: '"Trebuchet MS", sans-serif', label: 'Trebuchet MS' },
  { value: 'Calibri, sans-serif', label: 'Calibri' },
  { value: '"Lucida Sans Unicode", "Lucida Grande", sans-serif', label: 'Lucida Sans' },
  { value: '"Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif', label: 'Franklin Gothic' },
  { value: '"Century Gothic", sans-serif', label: 'Century Gothic' },
  { value: 'Optima, sans-serif', label: 'Optima' },
  { value: 'Futura, sans-serif', label: 'Futura' },
  { value: '"Gill Sans", sans-serif', label: 'Gill Sans' },
  { value: '"Avenir Next", Avenir, sans-serif', label: 'Avenir' },

  // Serif
  { value: 'Georgia, "Times New Roman", serif', label: 'Georgia' },
  { value: '"Times New Roman", Times, serif', label: 'Times New Roman' },
  { value: 'Times, "Times New Roman", serif', label: 'Times' },
  { value: 'Cambria, Georgia, serif', label: 'Cambria' },
  { value: 'Garamond, serif', label: 'Garamond' },
  { value: '"Book Antiqua", "Palatino Linotype", Palatino, serif', label: 'Book Antiqua' },
  { value: '"Palatino Linotype", Palatino, serif', label: 'Palatino' },
  { value: 'Baskerville, "Baskerville Old Face", serif', label: 'Baskerville' },
  { value: 'Didot, serif', label: 'Didot' },
  { value: '"Playfair Display", serif', label: 'Playfair Display' },
  { value: 'Merriweather, serif', label: 'Merriweather' },
  { value: 'Lora, serif', label: 'Lora' },

  // Monospace
  { value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', label: 'System Mono' },
  { value: '"Courier New", Courier, monospace', label: 'Courier New' },
  { value: '"Lucida Console", Monaco, monospace', label: 'Lucida Console' },
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: 'Menlo, Monaco, "Courier New", monospace', label: 'Menlo' },
  { value: '"JetBrains Mono", monospace', label: 'JetBrains Mono' },
  { value: '"Fira Code", monospace', label: 'Fira Code' },
  { value: '"Source Code Pro", monospace', label: 'Source Code Pro' },

  // Display / handwriting / novelty
  { value: 'Impact, Haettenschweiler, sans-serif', label: 'Impact' },
  { value: '"Comic Sans MS", cursive, sans-serif', label: 'Comic Sans' },
  { value: '"Brush Script MT", cursive', label: 'Brush Script' },
  { value: '"Copperplate Gothic Light", Copperplate, sans-serif', label: 'Copperplate' },
  { value: '"Lucida Handwriting", cursive', label: 'Lucida Handwriting' },
  { value: '"Papyrus", fantasy', label: 'Papyrus' },
  { value: '"Chalkduster", fantasy', label: 'Chalkduster' },
  { value: '"Marker Felt", cursive', label: 'Marker Felt' },
  { value: '"Dancing Script", cursive', label: 'Dancing Script' },
  { value: '"Pacifico", cursive', label: 'Pacifico' },
];

const FONT_SIZES: string[] = [
  '10px',
  '12px',
  '14px',
  '16px',
  '18px',
  '20px',
  '24px',
  '28px',
  '32px',
  '40px',
  '48px',
  '64px',
];

const TEXT_COLORS: { value: string; labelKey: ColorLabelKey; swatch: string }[] = [
  { value: 'default', labelKey: 'default', swatch: '#111827' },
  { value: 'gray', labelKey: 'gray', swatch: '#6b7280' },
  { value: 'slate', labelKey: 'slate', swatch: '#475569' },
  { value: 'stone', labelKey: 'stone', swatch: '#78716c' },
  { value: 'brown', labelKey: 'brown', swatch: '#92400e' },
  { value: 'red', labelKey: 'red', swatch: '#dc2626' },
  { value: 'rose', labelKey: 'rose', swatch: '#e11d48' },
  { value: 'pink', labelKey: 'pink', swatch: '#db2777' },
  { value: 'fuchsia', labelKey: 'fuchsia', swatch: '#c026d3' },
  { value: 'purple', labelKey: 'purple', swatch: '#9333ea' },
  { value: 'violet', labelKey: 'violet', swatch: '#7c3aed' },
  { value: 'indigo', labelKey: 'indigo', swatch: '#4f46e5' },
  { value: 'blue', labelKey: 'blue', swatch: '#2563eb' },
  { value: 'sky', labelKey: 'sky', swatch: '#0284c7' },
  { value: 'cyan', labelKey: 'cyan', swatch: '#0891b2' },
  { value: 'teal', labelKey: 'teal', swatch: '#0d9488' },
  { value: 'emerald', labelKey: 'emerald', swatch: '#059669' },
  { value: 'green', labelKey: 'green', swatch: '#16a34a' },
  { value: 'lime', labelKey: 'lime', swatch: '#65a30d' },
  { value: 'yellow', labelKey: 'yellow', swatch: '#ca8a04' },
  { value: 'amber', labelKey: 'amber', swatch: '#d97706' },
  { value: 'orange', labelKey: 'orange', swatch: '#ea580c' },
  { value: 'zinc', labelKey: 'zinc', swatch: '#52525b' },
  { value: 'neutral', labelKey: 'neutral', swatch: '#525252' },
];

const BG_COLORS: { value: string; labelKey: ColorLabelKey; swatch: string }[] = [
  { value: 'default', labelKey: 'none', swatch: '#ffffff' },
  { value: 'gray', labelKey: 'gray', swatch: '#e5e7eb' },
  { value: 'slate', labelKey: 'slate', swatch: '#cbd5e1' },
  { value: 'stone', labelKey: 'stone', swatch: '#d6d3d1' },
  { value: 'brown', labelKey: 'brown', swatch: '#fde4c9' },
  { value: 'red', labelKey: 'red', swatch: '#fecaca' },
  { value: 'rose', labelKey: 'rose', swatch: '#fecdd3' },
  { value: 'pink', labelKey: 'pink', swatch: '#fbcfe8' },
  { value: 'fuchsia', labelKey: 'fuchsia', swatch: '#f5d0fe' },
  { value: 'purple', labelKey: 'purple', swatch: '#e9d5ff' },
  { value: 'violet', labelKey: 'violet', swatch: '#ddd6fe' },
  { value: 'indigo', labelKey: 'indigo', swatch: '#c7d2fe' },
  { value: 'blue', labelKey: 'blue', swatch: '#bfdbfe' },
  { value: 'sky', labelKey: 'sky', swatch: '#bae6fd' },
  { value: 'cyan', labelKey: 'cyan', swatch: '#a5f3fc' },
  { value: 'teal', labelKey: 'teal', swatch: '#99f6e4' },
  { value: 'emerald', labelKey: 'emerald', swatch: '#a7f3d0' },
  { value: 'green', labelKey: 'green', swatch: '#bbf7d0' },
  { value: 'lime', labelKey: 'lime', swatch: '#d9f99d' },
  { value: 'yellow', labelKey: 'yellow', swatch: '#fde68a' },
  { value: 'amber', labelKey: 'amber', swatch: '#fcd34d' },
  { value: 'orange', labelKey: 'orange', swatch: '#fed7aa' },
  { value: 'zinc', labelKey: 'zinc', swatch: '#e4e4e7' },
  { value: 'neutral', labelKey: 'neutral', swatch: '#e5e5e5' },
];

interface ToolbarState {
  activeStyles: Record<string, boolean | string>;
  activeBlockType: string;
  activeHeadingLevel: number | null;
  activeTextAlignment: TextAlignment;
  /** Computed font-size of the element containing the caret — reflects
   *  the *rendered* size (CSS + any applied fontSize style) so the
   *  trigger always shows a real number. */
  effectiveFontSize: string;
  /** True when the caret is actually inside the BlockNote editor. When
   *  it's in the title (or anywhere else), we ignore the editor's
   *  stored marks and fall back to the rendered font-size. */
  caretInsideEditor: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const INITIAL_TOOLBAR_STATE: ToolbarState = {
  activeStyles: {},
  activeBlockType: 'paragraph',
  activeHeadingLevel: null,
  activeTextAlignment: 'left',
  effectiveFontSize: '16px',
  caretInsideEditor: false,
  canUndo: false,
  canRedo: false,
};

// Shallow equality so we skip setState when the selection change didn't
// actually affect anything we display. With 20+ buttons each re-render is
// expensive, and BlockNote fires onSelectionChange on every keystroke.
function toolbarStateEqual(a: ToolbarState, b: ToolbarState) {
  if (
    a.activeBlockType !== b.activeBlockType ||
    a.activeHeadingLevel !== b.activeHeadingLevel ||
    a.activeTextAlignment !== b.activeTextAlignment ||
    a.effectiveFontSize !== b.effectiveFontSize ||
    a.caretInsideEditor !== b.caretInsideEditor ||
    a.canUndo !== b.canUndo ||
    a.canRedo !== b.canRedo
  ) {
    return false;
  }
  const ka = Object.keys(a.activeStyles);
  const kb = Object.keys(b.activeStyles);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a.activeStyles[k] !== b.activeStyles[k]) return false;
  }
  return true;
}

/** True when the current window selection anchor lives inside a
 *  `.bn-editor` subtree — i.e. the caret is in the BlockNote body,
 *  not in the title, not in some other contenteditable. */
function selectionInsideEditor(): boolean {
  if (typeof window === 'undefined') return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  let node: Node | null = sel.anchorNode;
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!(node instanceof Element)) return false;
  return !!node.closest('.bn-editor');
}

/** Read the computed font-size of the element containing the current
 *  window selection. Works for any contenteditable on the page — the
 *  document title, a heading, a paragraph, a span with a custom
 *  fontSize style — so the toolbar shows the actual rendered size. */
function readEffectiveFontSize(): string {
  if (typeof window === 'undefined') return '16px';
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '16px';
  let node: Node | null = sel.anchorNode;
  if (!node) return '16px';
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!(node instanceof Element)) return '16px';
  const size = window.getComputedStyle(node).fontSize;
  const px = Number.parseFloat(size);
  return Number.isFinite(px) ? `${Math.round(px)}px` : '16px';
}

type TiptapActiveApi = {
  isActive?: (name: string) => boolean;
  getAttributes?: (name: string) => Record<string, unknown>;
};

/** Collect the active inline styles from TipTap's `isActive()`. */
function readActiveStyles(editor: BlockNoteEditorInstance): Record<string, boolean | string> {
  // IMPORTANT: The active-styles tracking is driven ENTIRELY by
  // TipTap's `isActive()` — not by BlockNote's `getActiveStyles()`.
  // BlockNote reads `selection.$to.marks()`, which at an empty
  // cursor returns the marks of the previous character, so after
  // a user untoggled a mark via storedMarks the button would
  // INCORRECTLY remain highlighted (the cursor is still sitting
  // next to previously-styled text). TipTap's `isActive` uses the
  // current selection + storedMarks together, which matches what
  // `toggleMark` actually toggles against — so the toolbar state
  // tracks the toggle perfectly.
  const activeStyles: Record<string, boolean | string> = {};
  const tt = (editor as unknown as { _tiptapEditor?: TiptapActiveApi })._tiptapEditor;
  if (!tt?.isActive) return activeStyles;

  for (const markName of ['bold', 'italic', 'underline', 'strike', 'code']) {
    if (tt.isActive(markName)) activeStyles[markName] = true;
  }
  for (const markName of ['textColor', 'backgroundColor', 'fontFamily', 'fontSize']) {
    if (!tt.isActive(markName)) continue;
    const attrs = tt.getAttributes?.(markName) ?? {};
    const val = (attrs as { stringValue?: string }).stringValue;
    if (typeof val === 'string' && val.length > 0) {
      activeStyles[markName] = val;
    }
  }
  return activeStyles;
}

/** Read undo / redo history depths directly from the prosemirror-history
 *  plugin. `editor.can().undo()` through TipTap's wrapper returned false
 *  even with history present, so we go to the source: the plugin's own state. */
function readHistoryAvailability(editor: BlockNoteEditorInstance): { canUndo: boolean; canRedo: boolean } {
  try {
    const pmState = (editor as unknown as { _tiptapEditor?: { state: unknown } })._tiptapEditor?.state;
    if (pmState) {
      return {
        canUndo: undoDepth(pmState as never) > 0,
        canRedo: redoDepth(pmState as never) > 0,
      };
    }
  } catch {
    /* noop */
  }
  return { canUndo: false, canRedo: false };
}

function computeToolbarState(editor: BlockNoteEditorInstance, lastState: ToolbarState): ToolbarState {
  try {
    const activeStyles = readActiveStyles(editor);
    const inside = selectionInsideEditor();
    const block = editor.getTextCursorPosition().block;
    const props = (block as { props?: Record<string, unknown> } | undefined)?.props;
    const { canUndo, canRedo } = readHistoryAvailability(editor);

    return {
      activeStyles,
      activeBlockType: block?.type || 'paragraph',
      activeHeadingLevel: typeof props?.level === 'number' ? (props.level as number) : null,
      activeTextAlignment: (props?.textAlignment as TextAlignment | undefined) || 'left',
      effectiveFontSize: readEffectiveFontSize(),
      caretInsideEditor: inside,
      canUndo,
      canRedo,
    };
  } catch {
    return {
      ...lastState,
      effectiveFontSize: readEffectiveFontSize(),
      caretInsideEditor: selectionInsideEditor(),
    };
  }
}

// The static toolbar wears the design of the mail compose formatting bar
// (`app/weldmail/components/compose-surface.tsx`): one rounded, tinted bar of
// 28px ghost buttons with hairline separators. Keep the two in step.
const TOOL_BUTTON =
  'h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors';
const TOOL_MENU_BUTTON = cn(TOOL_BUTTON, 'data-[state=open]:bg-muted data-[state=open]:text-foreground');
const TOOL_SELECT =
  'h-7 px-2 flex items-center gap-1 text-[13.5px] font-normal rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground';
const TOOL_SEPARATOR = 'w-px h-4 bg-border';

// Same glyphs as the compose bar, which draws these four by hand.
function BoldGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
      <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
    </svg>
  );
}
function ItalicGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="19" y1="4" x2="10" y2="4" />
      <line x1="14" y1="20" x2="5" y2="20" />
      <line x1="15" y1="4" x2="9" y2="20" />
    </svg>
  );
}
function UnderlineGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
      <line x1="4" y1="21" x2="20" y2="21" />
    </svg>
  );
}
function BulletListGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}
function NumberedListGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="10" y1="6" x2="21" y2="6" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <line x1="10" y1="18" x2="21" y2="18" />
      <path d="M4 6h1v4" />
      <path d="M4 10h2" />
      <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
    </svg>
  );
}

export function StaticFormattingToolbar({ editor }: Readonly<{ editor: BlockNoteEditorInstance }>) {
  const strings = getBlockEditorStrings();
  const tb = strings.toolbar;
  const [state, setState] = useState<ToolbarState>(INITIAL_TOOLBAR_STATE);
  const { activeStyles, activeBlockType, activeHeadingLevel, activeTextAlignment } = state;
  const lastStateRef = useRef<ToolbarState>(INITIAL_TOOLBAR_STATE);

  useEffect(() => {
    const compute = (): ToolbarState => computeToolbarState(editor, lastStateRef.current);

    // State updates are synchronous. Previously we coalesced multiple
    // selection/transaction events per frame via requestAnimationFrame,
    // but that introduced a ~16ms window where a double-click on a
    // toggle button (e.g. Italic) could race the state update — making
    // it look like "sometimes I can't unselect italic". The shallow
    // equality check already short-circuits no-op updates, and React's
    // automatic batching handles rapid consecutive setState calls.
    const schedule = () => {
      const next = compute();
      if (toolbarStateEqual(lastStateRef.current, next)) return;
      lastStateRef.current = next;
      setState(next);
    };

    // Prime the initial state synchronously.
    const initial = compute();
    lastStateRef.current = initial;
    setState(initial);

    // BlockNote's `onSelectionChange` is wired to TipTap's `selectionUpdate`,
    // and its `onChange` is wired to TipTap's `update` — but `update` ONLY
    // fires when the doc actually changes. A storedMarks-only transaction
    // (what `toggleMark` produces at an empty cursor) doesn't change the
    // doc, so neither event fires and the toolbar never refreshed until
    // the user typed. TipTap's lower-level `transaction` event DOES fire
    // for every transaction, so subscribe directly to it.
    const unsubSelection = editor.onSelectionChange(schedule);
    const tt = (editor as unknown as {
      _tiptapEditor?: {
        on: (evt: string, cb: () => void) => void;
        off: (evt: string, cb: () => void) => void;
      };
    })._tiptapEditor;
    tt?.on('transaction', schedule);

    // Fire whenever the window selection moves — covers the title
    // contenteditable (and any other contenteditable) which BlockNote
    // doesn't know about, so the font-size trigger stays accurate when
    // the caret is in the document title.
    document.addEventListener('selectionchange', schedule);

    return () => {
      unsubSelection?.();
      tt?.off('transaction', schedule);
      document.removeEventListener('selectionchange', schedule);
    };
  }, [editor]);

  // All toolbar actions go through BlockNote's public API. Focus the
  // editor first so the subsequent mutation operates on the user's
  // selection (which ProseMirror preserves even when the editor is
  // visually blurred by a button click). `toggleStyles` / `addStyles` /
  // `removeStyles` / `updateBlock` are the same primitives BlockNote
  // uses in its own built-in toolbars — simple and well-tested.
  // Always keep a synchronous reference to what the toolbar is DISPLAYING
  // as active. If the user clicks Bold, the action must match exactly
  // what the button shows — otherwise a race between a keystroke and a
  // click can misfire: `toggleMark` reads live editor state mid-typing
  // and may flip the wrong way.
  const activeStylesRef = useRef<Record<string, boolean | string>>({});
  useEffect(() => {
    activeStylesRef.current = activeStyles;
  }, [activeStyles]);

  const toggleStyle = useCallback(
    (style: BasicStyle) => {
      editor.focus();
      // UI-driven toggle: explicit add or remove based on what the
      // button is currently displaying. No reliance on toggleMark's
      // internal isActive check, which can race with typing.
      if (activeStylesRef.current[style]) {
        editor.removeStyles({ [style]: true } as never);
      } else {
        editor.addStyles({ [style]: true } as never);
      }
    },
    [editor],
  );

  const setBlockType = useCallback(
    (type: StaticBlockType, level?: HeadingLevel) => {
      editor.focus();
      const block = editor.getTextCursorPosition().block;
      if (!block) return;
      if (type === 'heading') {
        editor.updateBlock(block, { type, props: { level: level || 1 } } as never);
      } else {
        editor.updateBlock(block, { type } as never);
      }
    },
    [editor],
  );

  const setAlignment = useCallback(
    (alignment: TextAlignment) => {
      editor.focus();
      const block = editor.getTextCursorPosition().block;
      if (!block) return;
      editor.updateBlock(block, { props: { textAlignment: alignment } } as never);
    },
    [editor],
  );

  const applyColor = useCallback(
    (kind: 'textColor' | 'backgroundColor', value: string) => {
      editor.focus();
      editor.addStyles({ [kind]: value } as never);
    },
    [editor],
  );

  // fontSize / fontFamily at an empty cursor: ProseMirror would only
  // store the mark for the *next* character, so the caret visually
  // stays at the previous size. Insert a ZWS carrying the new mark so
  // the caret lands inside a styled span immediately.
  const applyMarkAndReflectCaret = useCallback(
    (markName: 'fontSize' | 'fontFamily', value: string | undefined) => {
      editor.focus();
      if (!value) {
        try { editor.removeStyles({ [markName]: true } as never); } catch { /* noop */ }
        return;
      }
      editor.addStyles({ [markName]: value } as never);

      interface TiptapChain {
        focus: () => TiptapChain;
        setMark: (name: string, attrs: Record<string, unknown>) => TiptapChain;
        insertContent: (content: string) => TiptapChain;
        run: () => void;
      }

      const tt = (editor as unknown as { _tiptapEditor?: {
        state: { selection: { empty: boolean } };
        chain: () => TiptapChain;
      } })._tiptapEditor;

      try {
        if (tt?.state.selection.empty && selectionInsideEditor()) {
          tt.chain().focus().setMark(markName, { stringValue: value }).insertContent('​').run();
        }
      } catch { /* noop */ }
    },
    [editor],
  );

  const applyFontFamily = useCallback(
    (value: string) => applyMarkAndReflectCaret('fontFamily', value || undefined),
    [applyMarkAndReflectCaret],
  );

  const applyFontSize = useCallback(
    (value: string) => applyMarkAndReflectCaret('fontSize', value || undefined),
    [applyMarkAndReflectCaret],
  );

  // Comments — only available when the comments extension is registered
  // (collaborative documents). Starts a pending comment on the current
  // selection; the FloatingComposerController then renders the composer.
  const commentsExt = (editor as unknown as {
    extensions?: Map<string, { startPendingComment?: () => void }>;
  }).extensions?.get?.('comments');
  const hasComments = !!commentsExt;

  const addComment = useCallback(() => {
    editor.focus();
    const ext = (editor as unknown as {
      extensions?: Map<string, { startPendingComment?: () => void }>;
    }).extensions?.get?.('comments');
    ext?.startPendingComment?.();
  }, [editor]);

  const clearFormatting = useCallback(() => {
    editor.focus();
    const active = editor.getActiveStyles() as Record<string, unknown>;
    const removable: Record<string, true> = {};
    for (const key of Object.keys(active)) {
      if (active[key]) removable[key] = true;
    }
    if (Object.keys(removable).length > 0) {
      editor.removeStyles(removable as never);
    }
  }, [editor]);

  const undo = useCallback(() => {
    try {
      editor.focus();
      (editor as unknown as { undo: () => void }).undo();
    } catch { /* noop */ }
  }, [editor]);
  const redo = useCallback(() => {
    try {
      editor.focus();
      (editor as unknown as { redo: () => void }).redo();
    } catch { /* noop */ }
  }, [editor]);

  const applyLink = useCallback((url: string, text?: string) => {
    editor.focus();
    try {
      (editor as unknown as { createLink: (url: string, text?: string) => void }).createLink(
        url,
        text && text.length > 0 ? text : undefined,
      );
    } catch { /* noop */ }
  }, [editor]);

  const getSelectionText = useCallback(() => {
    const tt = (editor as unknown as { _tiptapEditor?: { state: { selection: { from: number; to: number } }; view: { state: { doc: { textBetween: (from: number, to: number, sep?: string) => string } } } } })._tiptapEditor;
    if (!tt) return '';
    try {
      const { from, to } = tt.state.selection;
      if (from === to) return '';
      return tt.view.state.doc.textBetween(from, to, ' ');
    } catch {
      return '';
    }
  }, [editor]);

  const nestBlock = useCallback(() => {
    editor.focus();
    try { (editor as unknown as { nestBlock: () => void }).nestBlock(); } catch { /* noop */ }
  }, [editor]);

  const unnestBlock = useCallback(() => {
    editor.focus();
    try { (editor as unknown as { unnestBlock: () => void }).unnestBlock(); } catch { /* noop */ }
  }, [editor]);

  const btn = (isActive: boolean) => cn(TOOL_BUTTON, isActive && 'bg-muted text-foreground');

  // Names of the block types added with the Notion-style blocks; BlockNote's
  // dictionary and our own strings are both in the app language.
  const toggleListLabel = editor.dictionary.slash_menu.toggle_list.title;
  const codeBlockLabel = editor.dictionary.slash_menu.code_block.title;
  const calloutLabel = strings.slashMenu.items.callout.title;

  const currentBlockLabel = (() => {
    if (activeBlockType === 'heading' && activeHeadingLevel) return tb.blocks[`heading${activeHeadingLevel as 1 | 2 | 3}` as 'heading1' | 'heading2' | 'heading3'];
    if (activeBlockType === 'quote') return tb.blocks.quote;
    if (activeBlockType === 'bulletListItem') return tb.blocks.bulletList;
    if (activeBlockType === 'numberedListItem') return tb.blocks.numberedList;
    if (activeBlockType === 'checkListItem') return tb.blocks.checkList;
    if (activeBlockType === 'toggleListItem') return toggleListLabel;
    if (activeBlockType === 'codeBlock') return codeBlockLabel;
    if (activeBlockType === 'callout') return calloutLabel;
    return tb.blocks.paragraph;
  })();

  const alignIcon = (a: TextAlignment) => {
    if (a === 'center') return AlignCenter;
    if (a === 'right') return AlignRight;
    if (a === 'justify') return AlignJustify;
    return AlignLeft;
  };
  const AlignCurrent = alignIcon(activeTextAlignment);

  return (
    <TooltipProvider delayDuration={10000} skipDelayDuration={300}>
    <div
      className="inline-flex items-center gap-1 rounded-lg bg-muted/60 px-1 py-1 max-w-full flex-wrap"
      // Keep the caret inside the document when clicking any toolbar
      // control — the browser's default mousedown behaviour moves focus
      // to the clicked button and collapses the editor selection. Skip
      // this for anything rendered inside a Popover/Dropdown, so the
      // search input and menu items inside those menus can receive
      // focus and clicks normally (popovers propagate React events back
      // through the component tree even though they render in a portal).
      role="toolbar"
      onMouseDown={(e) => {
        const target = e.target as Element | null;
        if (target?.closest('[data-slot="popover-content"], [data-slot="dropdown-menu-content"]')) {
          return;
        }
        e.preventDefault();
      }}
    >
      {/* Undo / Redo */}
      <ToolbarTooltip label={tb.undo}>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className={cn(
            btn(false),
            !state.canUndo && 'opacity-40 pointer-events-none cursor-not-allowed',
          )}
          onClick={undo}
          disabled={!state.canUndo}
          aria-disabled={!state.canUndo}
        >
          <Undo className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.redo}>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className={cn(
            btn(false),
            !state.canRedo && 'opacity-40 pointer-events-none cursor-not-allowed',
          )}
          onClick={redo}
          disabled={!state.canRedo}
          aria-disabled={!state.canRedo}
        >
          <Redo className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>

      <div className={TOOL_SEPARATOR} />

      {/* Block type — Popover instead of DropdownMenu so opening the
          menu doesn't yank the caret out of the document. */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className={TOOL_SELECT}
            title={tb.blockType}
          >
            <span className="truncate max-w-[110px]">{currentBlockLabel}</span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-48 p-1"
          onOpenAutoFocus={(e: Event) => e.preventDefault()}
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
        >
          {(() => {
            const items = [
              { type: 'paragraph' as const, label: tb.blocks.paragraph, Icon: Pilcrow, match: activeBlockType === 'paragraph' },
              { type: 'heading' as const, level: 1 as const, label: tb.blocks.heading1, Icon: Heading1, match: activeBlockType === 'heading' && activeHeadingLevel === 1 },
              { type: 'heading' as const, level: 2 as const, label: tb.blocks.heading2, Icon: Heading2, match: activeBlockType === 'heading' && activeHeadingLevel === 2 },
              { type: 'heading' as const, level: 3 as const, label: tb.blocks.heading3, Icon: Heading3, match: activeBlockType === 'heading' && activeHeadingLevel === 3 },
              { type: null, label: '__separator__', Icon: null as never, match: false },
              { type: 'bulletListItem' as const, label: tb.blocks.bulletList, Icon: List, match: activeBlockType === 'bulletListItem' },
              { type: 'numberedListItem' as const, label: tb.blocks.numberedList, Icon: ListOrdered, match: activeBlockType === 'numberedListItem' },
              { type: 'checkListItem' as const, label: tb.blocks.checkList, Icon: ListChecks, match: activeBlockType === 'checkListItem' },
              { type: 'toggleListItem' as const, label: toggleListLabel, Icon: ListCollapse, match: activeBlockType === 'toggleListItem' },
              { type: null, label: '__separator__', Icon: null as never, match: false },
              { type: 'quote' as const, label: tb.blocks.quote, Icon: Quote, match: activeBlockType === 'quote' },
              { type: 'callout' as const, label: calloutLabel, Icon: Lightbulb, match: activeBlockType === 'callout' },
              { type: 'codeBlock' as const, label: codeBlockLabel, Icon: SquareCode, match: activeBlockType === 'codeBlock' },
            ];
            let separatorCount = 0;
            return items.map((item) => {
              if (item.label === '__separator__') {
                return <div key={`separator-${separatorCount++}`} className="my-1 h-px bg-border" />;
              }
              const { type, label, Icon, match } = item as Exclude<typeof item, { label: '__separator__' }>;
              return (
                <Button
                  variant="ghost"
                  key={label}
                  type="button"
                  onClick={() => setBlockType(type as never, 'level' in item ? item.level : undefined)}
                  className={cn(
                    'w-full flex items-center px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent',
                    match && 'bg-accent text-foreground font-medium',
                  )}
                >
                  <Icon className="h-4 w-4 mr-2" />
                  <span>{label}</span>
                </Button>
              );
            });
          })()}
        </PopoverContent>
      </Popover>

      <div className={TOOL_SEPARATOR} />

      {/* Font family — Popover with a search input at the top. */}
      <FontFamilyPicker
        currentFamily={(activeStyles.fontFamily as string | undefined) || ''}
        onPick={applyFontFamily}
      />

      {/* Font size — Popover instead of DropdownMenu so we can prevent
           focus from moving into the menu. That way the caret stays in
           the document while the user is picking a size. */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className={TOOL_SELECT}
            title={tb.fontSize}
          >
            <span className="tabular-nums">
              {state.caretInsideEditor && activeStyles.fontSize
                ? (activeStyles.fontSize as string)
                : state.effectiveFontSize}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-32 max-h-80 overflow-y-auto p-1"
          onOpenAutoFocus={(e: Event) => e.preventDefault()}
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
        >
          {(() => {
            const currentSize =
              state.caretInsideEditor && activeStyles.fontSize
                ? (activeStyles.fontSize as string)
                : state.effectiveFontSize;
            return (
              <>
                {FONT_SIZES.map((s) => (
                  <Button
                    variant="ghost"
                    key={s}
                    type="button"
                    className={cn(
                      'w-full flex items-center px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent tabular-nums',
                      s === currentSize && 'bg-accent text-foreground font-medium',
                    )}
                    onClick={() => applyFontSize(s)}
                  >
                    <span>{s}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        s === currentSize ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </Button>
                ))}
              </>
            );
          })()}
        </PopoverContent>
      </Popover>

      <div className={TOOL_SEPARATOR} />

      {/* Inline styles */}
      <ToolbarTooltip label={tb.bold}>
        <Button variant="ghost" size="icon" type="button" className={btn(!!activeStyles.bold)} onClick={() => toggleStyle('bold')}>
          <BoldGlyph />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.italic}>
        <Button variant="ghost" size="icon" type="button" className={btn(!!activeStyles.italic)} onClick={() => toggleStyle('italic')}>
          <ItalicGlyph />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.underline}>
        <Button variant="ghost" size="icon" type="button" className={btn(!!activeStyles.underline)} onClick={() => toggleStyle('underline')}>
          <UnderlineGlyph />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.strikethrough}>
        <Button variant="ghost" size="icon" type="button" className={btn(!!activeStyles.strike)} onClick={() => toggleStyle('strike')}>
          <Strikethrough className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.inlineCode}>
        <Button variant="ghost" size="icon" type="button" className={btn(!!activeStyles.code)} onClick={() => toggleStyle('code')}>
          <Code className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>

      {/* Text color */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className={TOOL_MENU_BUTTON}
            title={tb.textColor}
          >
            <Baseline className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-48 p-2"
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
          onOpenAutoFocus={(e: Event) => e.preventDefault()}
          // Radix's InteractOutside events wrap the original DOM event
          // in `e.detail.originalEvent`. Clicking the readOnly inputs
          // inside the embedded ColorPicker would otherwise be treated
          // as an outside-interaction and close the popover.
          onPointerDownOutside={(e) => {
            const originalTarget = (e as unknown as { detail: { originalEvent: { target: Element | null } } })
              .detail.originalEvent.target;
            if (originalTarget?.closest('[data-color-picker-inner]')) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e) => {
            const originalTarget = (e as unknown as { detail: { originalEvent: { target: Element | null } } })
              .detail.originalEvent.target;
            if (originalTarget?.closest('[data-color-picker-inner]')) {
              e.preventDefault();
            }
          }}
        >
          <ColorSwatchGridWithCustom
            swatches={TEXT_COLORS}
            current={activeStyles.textColor as string | undefined}
            onPick={(value) => applyColor('textColor', value)}
            checkIconClass="text-white"
          />
        </PopoverContent>
      </Popover>

      {/* Highlight / background color */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className={TOOL_MENU_BUTTON}
            title={tb.highlight}
          >
            <Highlighter className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-48 p-2"
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
          onOpenAutoFocus={(e: Event) => e.preventDefault()}
          // Radix's InteractOutside events wrap the original DOM event
          // in `e.detail.originalEvent`. Clicking the readOnly inputs
          // inside the embedded ColorPicker would otherwise be treated
          // as an outside-interaction and close the popover.
          onPointerDownOutside={(e) => {
            const originalTarget = (e as unknown as { detail: { originalEvent: { target: Element | null } } })
              .detail.originalEvent.target;
            if (originalTarget?.closest('[data-color-picker-inner]')) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e) => {
            const originalTarget = (e as unknown as { detail: { originalEvent: { target: Element | null } } })
              .detail.originalEvent.target;
            if (originalTarget?.closest('[data-color-picker-inner]')) {
              e.preventDefault();
            }
          }}
        >
          <ColorSwatchGridWithCustom
            swatches={BG_COLORS}
            current={activeStyles.backgroundColor as string | undefined}
            onPick={(value) => applyColor('backgroundColor', value)}
            swatchBorder
            checkIconClass="text-foreground"
          />
        </PopoverContent>
      </Popover>

      {/* Link */}
      <LinkButton onApply={applyLink} getSelectionText={getSelectionText} />

      <div className={TOOL_SEPARATOR} />

      {/* Alignment — Popover instead of DropdownMenu so we can prevent
          focus from ever leaving the editor. DropdownMenu moves focus
          to the menu content on open for keyboard nav, which yanks the
          caret out of the document. */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className={TOOL_MENU_BUTTON}
            title={tb.alignment}
          >
            <AlignCurrent className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-40 p-1"
          onOpenAutoFocus={(e: Event) => e.preventDefault()}
          onCloseAutoFocus={(e: Event) => e.preventDefault()}
        >
          {([
            { value: 'left', label: tb.align.left, Icon: AlignLeft },
            { value: 'center', label: tb.align.center, Icon: AlignCenter },
            { value: 'right', label: tb.align.right, Icon: AlignRight },
            { value: 'justify', label: tb.align.justify, Icon: AlignJustify },
          ] as const).map(({ value, label, Icon }) => {
            const isActive = activeTextAlignment === value;
            return (
              <Button
                variant="ghost"
                key={value}
                type="button"
                onClick={() => setAlignment(value)}
                className={cn(
                  'w-full flex items-center px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent',
                  isActive && 'bg-accent text-foreground font-medium',
                )}
              >
                <Icon className="h-4 w-4 mr-2" />
                <span>{label}</span>
              </Button>
            );
          })}
        </PopoverContent>
      </Popover>

      {/* Lists */}
      <ToolbarTooltip label={tb.blocks.bulletList}>
        <Button variant="ghost" size="icon" type="button" className={btn(activeBlockType === 'bulletListItem')} onClick={() => setBlockType('bulletListItem')}>
          <BulletListGlyph />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.blocks.numberedList}>
        <Button variant="ghost" size="icon" type="button" className={btn(activeBlockType === 'numberedListItem')} onClick={() => setBlockType('numberedListItem')}>
          <NumberedListGlyph />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.blocks.checkList}>
        <Button variant="ghost" size="icon" type="button" className={btn(activeBlockType === 'checkListItem')} onClick={() => setBlockType('checkListItem')}>
          <ListChecks className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>

      {/* Outdent / Indent */}
      <ToolbarTooltip label={tb.decreaseIndent}>
        <Button variant="ghost" size="icon" type="button" className={btn(false)} onClick={unnestBlock}>
          <IndentDecrease className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={tb.increaseIndent}>
        <Button variant="ghost" size="icon" type="button" className={btn(false)} onClick={nestBlock}>
          <IndentIncrease className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>

      <div className={TOOL_SEPARATOR} />

      {/* Add comment (collaborative documents only) */}
      {hasComments && (
        <ToolbarTooltip label={tb.addComment}>
          <Button variant="ghost" size="icon" type="button" className={btn(false)} onClick={addComment}>
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </ToolbarTooltip>
      )}

      {/* Clear formatting */}
      <ToolbarTooltip label={tb.clearFormatting}>
        <Button variant="ghost" size="icon" type="button" className={btn(false)} onClick={clearFormatting}>
          <RemoveFormatting className="h-4 w-4" />
        </Button>
      </ToolbarTooltip>
    </div>
    </TooltipProvider>
  );
}

function ToolbarTooltip({ label, children }: Readonly<{ label: string; children: React.ReactElement }>) {
  // The shared shadcn Tooltip wrapper always nests its own TooltipProvider
  // with a default 300ms delay, which shadows whatever `delayDuration` the
  // outer TooltipProvider is set to. Passing `delayDuration` directly on
  // <Tooltip> makes the Radix Root use our value instead of inheriting.
  return (
    <Tooltip delayDuration={800}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="text-xs px-2 py-1">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function FontFamilyPicker({
  currentFamily,
  onPick,
}: Readonly<{
  currentFamily: string;
  onPick: (value: string) => void;
}>) {
  const tb = getBlockEditorStrings().toolbar;
  const [open, setOpen] = useState(false);
  const fontLabel = (f: { value: string; label: string }) => (f.value === '' ? tb.fontDefault : f.label);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          className={TOOL_SELECT}
          title={tb.font}
        >
          <span className="truncate max-w-[90px]">
            {fontLabel(FONT_FAMILIES.find((f) => f.value === currentFamily) ?? FONT_FAMILIES[0])}
          </span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-0"
        // Let Radix auto-focus the first focusable child (the
        // CommandInput) so the user can start typing to search the
        // moment the popover opens.
        onCloseAutoFocus={(e: Event) => e.preventDefault()}
      >
        <Command>
          <CommandInput placeholder={tb.searchFonts} />
          <CommandList>
            <CommandEmpty>{tb.noFontsMatch}</CommandEmpty>
            <CommandGroup className="pl-1 pr-0 py-1">
              {FONT_FAMILIES.map((f) => (
                <CommandItem
                  key={f.label}
                  value={fontLabel(f)}
                  onSelect={() => {
                    onPick(f.value);
                    setOpen(false);
                  }}
                  style={{ fontFamily: f.value || undefined }}
                  className={cn(
                    f.value === currentFamily && 'bg-accent text-accent-foreground',
                  )}
                >
                  <span>{fontLabel(f)}</span>
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4',
                      f.value === currentFamily ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ColorSwatchGridWithCustom({
  swatches,
  current,
  onPick,
  swatchBorder,
  checkIconClass,
}: Readonly<{
  swatches: { value: string; labelKey: ColorLabelKey; swatch: string }[];
  current: string | undefined;
  onPick: (value: string) => void;
  swatchBorder?: boolean;
  checkIconClass: string;
}>) {
  const strings = getBlockEditorStrings().toolbar;
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState(
    typeof current === 'string' && current.startsWith('#') ? current : '#3b82f6',
  );

  if (showCustom) {
    return (
      <div
        className="flex flex-col gap-2"
        data-color-picker-inner
      >
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            type="button"
            onClick={() => setShowCustom(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {strings.back}
          </Button>
          <span className="text-xs text-muted-foreground">{strings.customColor}</span>
        </div>
        <ColorPicker
          defaultValue={customValue}
          onChange={((value: unknown) => {
            if (!Array.isArray(value)) return;
            const [r, g, b] = value as [number, number, number, number];
            const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
            const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            setCustomValue(hex);
            onPick(hex);
          }) as never}
          className="h-auto w-full"
        >
          <ColorPickerSelection className="h-40 rounded-lg" />
          <ColorPickerHue />
          <ColorPickerFormat />
        </ColorPicker>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {swatches.map((c) => {
        const isActive = current === c.value;
        return (
          <Button
            variant="ghost"
            key={c.value}
            type="button"
            onClick={() => onPick(c.value)}
            title={strings.colors[c.labelKey]}
            className={cn(
              'w-6 h-6 rounded relative transition-all hover:scale-110',
              swatchBorder && 'border border-border',
              isActive && 'ring-2 ring-offset-1 ring-foreground',
            )}
            style={{ backgroundColor: c.swatch }}
          >
            {isActive && <Check className={cn('absolute inset-0 m-auto h-3 w-3', checkIconClass)} />}
          </Button>
        );
      })}
      <Button
        variant="ghost"
        type="button"
        title={strings.customColor}
        onClick={() => setShowCustom(true)}
        className="w-6 h-6 rounded border border-border relative transition-all hover:scale-110 overflow-hidden"
        style={{
          background:
            'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)',
        }}
      />
    </div>
  );
}

function LinkButton({
  onApply,
  getSelectionText,
}: Readonly<{
  onApply: (url: string, text?: string) => void;
  getSelectionText: () => string;
}>) {
  const tb = getBlockEditorStrings().toolbar;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [hadSelection, setHadSelection] = useState(false);

  // When the popover opens, snapshot whether the user had text selected.
  // If they did, the text is already highlighted — no need to ask for it.
  // If they didn't, show a Text field so they can type the link label
  // (matches Google Docs behaviour).
  useEffect(() => {
    if (!open) return;
    const selected = getSelectionText();
    setHadSelection(selected.length > 0);
    setText(selected);
  }, [open, getSelectionText]);

  const submit = () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    const normalized = /^[a-z]+:\/\//i.test(trimmedUrl) || trimmedUrl.startsWith('mailto:')
      ? trimmedUrl
      : `https://${trimmedUrl}`;
    const trimmedText = text.trim();
    const linkText = hadSelection
      ? undefined // keep existing selection's text
      : (trimmedText || trimmedUrl);
    onApply(normalized, linkText);
    setUrl('');
    setText('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          className={TOOL_MENU_BUTTON}
          title={tb.link.insertLink}
        >
          <LinkIcon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        onCloseAutoFocus={(e: Event) => e.preventDefault()}
      >
        <div className="grid gap-4">
          <h4 className="font-medium text-sm leading-none">{tb.link.insertLink}</h4>

          <div className="grid gap-2">
            {!hadSelection && (
              <div className="grid grid-cols-[70px_1fr] items-center gap-3">
                <Label htmlFor="link-text" className="text-xs">{tb.link.text}</Label>
                <Input
                  id="link-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={tb.link.textPlaceholder}
                  autoFocus
                  spellCheck={false}
                  className="h-8"
                />
              </div>
            )}
            <div className="grid grid-cols-[70px_1fr] items-center gap-3">
              <Label htmlFor="link-url" className="text-xs">URL</Label>
              <Input
                id="link-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="https://example.com"
                autoFocus={hadSelection}
                spellCheck={false}
                className="h-8"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={!url.trim()}>
              {tb.link.apply}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Selection toolbar (floats above a text selection, Attio-style)
// ============================================================================

type SelectionBlockType =
  | 'paragraph' | 'heading' | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote' | 'codeBlock';

interface SelectionAnchor {
  /** Left edge of the selection, viewport px */
  x: number;
  /** Top edge of the selection, viewport px */
  y: number;
}

const SELECTION_TOOLBAR_GAP = 8;
const SELECTION_TOOLBAR_EDGE = 8;
/** CSS highlight name, styled by ensureSelectionHighlightStyle */
const SELECTION_HIGHLIGHT = 'weld-editor-selection';

/**
 * Adds the ::highlight rule once. It lives here rather than in globals.css
 * because Lightning CSS (Tailwind's minifier) doesn't parse ::highlight()
 * yet and warns on every build.
 */
function ensureSelectionHighlightStyle() {
  const id = `${SELECTION_HIGHLIGHT}-style`;
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `::highlight(${SELECTION_HIGHLIGHT}) { background-color: Highlight; color: HighlightText; }`;
  document.head.appendChild(style);
}

const SELECTION_TEXT_BUTTON =
  'h-7 gap-1.5 rounded-md px-2 text-[13px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground';
const SELECTION_ICON_BUTTON =
  'h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground';
const SELECTION_SEPARATOR = 'mx-0.5 h-4 w-px bg-border';

type TiptapSelectionApi = {
  isFocused: boolean;
  state: {
    selection: { from: number; to: number; empty: boolean };
    doc: { textBetween: (from: number, to: number, sep?: string) => string };
  };
};

function getTiptap(editor: BlockNoteEditorInstance): TiptapSelectionApi | undefined {
  return (editor as unknown as { _tiptapEditor?: TiptapSelectionApi })._tiptapEditor;
}

/** Text of the editor's current selection ('' when collapsed). */
function readSelectedText(editor: BlockNoteEditorInstance): string {
  const tt = getTiptap(editor);
  if (!tt) return '';
  const { from, to, empty } = tt.state.selection;
  if (empty) return '';
  try {
    return tt.state.doc.textBetween(from, to, ' ');
  } catch {
    return '';
  }
}

/** Top-left of the browser selection, when it lies inside a BlockNote editor. */
function readSelectionAnchor(): SelectionAnchor | null {
  if (!selectionInsideEditor()) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return null;
  return { x: rect.left, y: rect.top };
}

function SelectionSwatch({ color, none }: Readonly<{ color?: string; none?: boolean }>) {
  if (none) {
    return (
      <span className="relative inline-block h-3.5 w-3.5 overflow-hidden rounded-[4px] border border-border bg-background">
        <span className="absolute left-1/2 top-1/2 h-px w-[140%] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-red-500" />
      </span>
    );
  }
  return (
    <span
      className={cn('inline-block h-3.5 w-3.5 rounded-[4px] border border-border', !color && 'bg-foreground')}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

const SELECTION_SWATCH =
  'relative size-6 shrink-0 rounded-[6px] p-0 ring-1 ring-inset ring-black/10 hover:ring-2 hover:ring-foreground/30 dark:ring-white/10';
const SELECTION_SWATCH_ACTIVE = 'ring-2 ring-foreground hover:ring-foreground dark:ring-foreground';

/** Colour squares for the selection toolbar's Text and Highlight menus, plus a custom colour. */
function SelectionColorMenu({
  swatches,
  current,
  onPick,
  highlight,
}: Readonly<{
  swatches: { value: string; labelKey: ColorLabelKey; swatch: string }[];
  current: string | undefined;
  onPick: (value: string) => void;
  /** Highlight menu: the default square is "None", drawn crossed out. */
  highlight?: boolean;
}>) {
  const strings = getBlockEditorStrings().toolbar;
  const [showCustom, setShowCustom] = useState(false);
  const active = current ?? 'default';
  const isCustom = !!current?.startsWith('#');

  // ColorPicker reports its colour from an effect that re-runs whenever its
  // `onChange` changes, and once on mount. A fresh callback per render would
  // loop (apply -> re-render -> new callback -> apply ...), so hand it a
  // stable one that skips the mount report and repeats of the same colour.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const lastCustomRef = useRef<string | null>(null);
  const handleCustomChange = useCallback((value: unknown) => {
    if (!Array.isArray(value)) return;
    const [r, g, b] = value as [number, number, number, number];
    const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    if (lastCustomRef.current === null) {
      lastCustomRef.current = hex;
      return;
    }
    if (hex === lastCustomRef.current) return;
    lastCustomRef.current = hex;
    onPickRef.current(hex);
  }, []);

  if (showCustom) {
    return (
      // Same width as the swatch grid (6 x 24px + 5 x 6px), so the menu keeps its size.
      <div className="flex w-[174px] flex-col gap-2" data-color-picker-inner>
        {/* Header bar, full-bleed over the menu's padding, with the way back. */}
        <div className="-mx-2 -mt-2 flex h-9 items-center gap-1 border-b px-1.5">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label={strings.back}
            title={strings.back}
            onClick={() => setShowCustom(false)}
            className="size-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-[13px] font-medium">{strings.customColor}</span>
        </div>
        <ColorPicker
          defaultValue={isCustom ? current : '#3b82f6'}
          onChange={handleCustomChange as never}
          className="h-auto w-full"
        >
          <ColorPickerSelection className="h-36 rounded-md" />
          <ColorPickerHue />
          <ColorPickerFormat />
        </ColorPicker>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-6 gap-1.5">
      {swatches.map((c) => {
        const isDefault = c.value === 'default';
        const isActive = active === c.value;
        return (
          <Button
            key={c.value}
            type="button"
            variant="ghost"
            title={strings.colors[c.labelKey]}
            aria-label={strings.colors[c.labelKey]}
            aria-pressed={isActive}
            onClick={() => onPick(c.value)}
            className={cn(
              SELECTION_SWATCH,
              isDefault && !highlight && 'bg-foreground hover:bg-foreground',
              isDefault && highlight && 'overflow-hidden bg-background hover:bg-background',
              isActive && SELECTION_SWATCH_ACTIVE,
            )}
            style={isDefault ? undefined : { backgroundColor: c.swatch }}
          >
            {isDefault && highlight ? (
              <span className="absolute left-1/2 top-1/2 h-px w-[140%] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-red-500" />
            ) : null}
          </Button>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        title={strings.customColor}
        aria-label={strings.customColor}
        onClick={() => {
          lastCustomRef.current = null;
          setShowCustom(true);
        }}
        className={cn(SELECTION_SWATCH, isCustom && SELECTION_SWATCH_ACTIVE)}
        style={{
          background:
            'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ec4899, #ef4444)',
        }}
      />
    </div>
  );
}

/**
 * The bar that appears above selected text: block type, text colour,
 * highlight, link, bold / italic / strikethrough, and an "Ask Agent"
 * action that sends the selection to the agent. Rendered by BlockEditor when
 * `selectionToolbar` is set.
 */
function SelectionToolbar({
  editor,
  onAskAgent,
}: Readonly<{
  editor: BlockNoteEditorInstance;
  onAskAgent?: (text: string) => void;
}>) {
  const strings = getBlockEditorStrings();
  const tb = strings.toolbar;
  const st = strings.selectionToolbar;
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const [state, setState] = useState<ToolbarState>(INITIAL_TOOLBAR_STATE);
  const [openMenu, setOpenMenu] = useState<'block' | 'text' | 'highlight' | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Refs so the selection listeners (subscribed once) see current values.
  const pointerDownRef = useRef(false);
  const keepOpenRef = useRef(false);
  /** The selected range, so it can stay painted while focus is in the bar. */
  const rangeRef = useRef<Range | null>(null);
  keepOpenRef.current = openMenu !== null || linkMode;

  useEffect(() => {
    const update = () => {
      if (pointerDownRef.current) return;
      const tt = getTiptap(editor);
      const text = readSelectedText(editor);
      const focusInToolbar = !!toolbarRef.current?.contains(document.activeElement);
      if (!text.trim() || (!tt?.isFocused && !focusInToolbar && !keepOpenRef.current)) {
        if (!keepOpenRef.current) setAnchor(null);
        return;
      }
      const next = readSelectionAnchor();
      if (next) {
        setAnchor(next);
        rangeRef.current = window.getSelection()?.getRangeAt(0).cloneRange() ?? null;
      }
      setState((prev) => {
        const computed = computeToolbarState(editor, prev);
        return toolbarStateEqual(prev, computed) ? prev : computed;
      });
    };

    // Like Notion and Attio, stay out of the way while the mouse is still
    // dragging out the selection; show once it's released. The editor's DOM
    // element doesn't exist yet when this effect first runs, so look it up
    // per event.
    const onPointerDown = (e: PointerEvent) => {
      const root = (editor as unknown as { domElement?: HTMLElement }).domElement;
      if (!root?.contains(e.target as Node)) return;
      pointerDownRef.current = true;
      setAnchor(null);
      setOpenMenu(null);
      setLinkMode(false);
    };
    const onPointerUp = () => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      // Let the browser settle the selection first.
      requestAnimationFrame(update);
    };
    // Only follow the selection while the bar is showing; a dismissed bar
    // must not come back on scroll or resize.
    const onScroll = () => {
      const next = readSelectionAnchor();
      if (next) setAnchor((prev) => (prev ? next : prev));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAnchor(null);
      setOpenMenu(null);
      setLinkMode(false);
    };

    const unsubSelection = editor.onSelectionChange(update);
    const tt = (editor as unknown as {
      _tiptapEditor?: { on: (evt: string, cb: () => void) => void; off: (evt: string, cb: () => void) => void };
    })._tiptapEditor;
    tt?.on('transaction', update);
    tt?.on('blur', update);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      unsubSelection?.();
      tt?.off('transaction', update);
      tt?.off('blur', update);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [editor]);

  // A menu or the link field closed after focus had already left the
  // document (a click elsewhere on the page): nothing holds the bar open now.
  useEffect(() => {
    if (openMenu || linkMode) return;
    const focusInToolbar = !!toolbarRef.current?.contains(document.activeElement);
    if (!getTiptap(editor)?.isFocused && !focusInToolbar) setAnchor(null);
  }, [editor, openMenu, linkMode]);

  // Focus moving into the bar (the link field) clears the browser's
  // selection highlight. Paint the selected range with the CSS Custom
  // Highlight API instead, so the text stays visibly selected.
  useEffect(() => {
    const highlights = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    if (!anchor || !highlights) return;
    ensureSelectionHighlightStyle();
    const sync = () => {
      const range = rangeRef.current;
      if (range && !getTiptap(editor)?.isFocused) {
        highlights.set(SELECTION_HIGHLIGHT, new Highlight(range));
      } else {
        highlights.delete(SELECTION_HIGHLIGHT);
      }
    };
    sync();
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', sync);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', sync);
      highlights.delete(SELECTION_HIGHLIGHT);
    };
  }, [editor, anchor]);

  // Measure the bar so it can be kept inside the viewport.
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, [anchor, linkMode, state]);

  const close = useCallback(() => {
    setAnchor(null);
    setOpenMenu(null);
    setLinkMode(false);
    setLinkUrl('');
  }, []);

  const toggleStyle = useCallback(
    (style: BasicStyle) => {
      editor.focus();
      if (state.activeStyles[style]) {
        editor.removeStyles({ [style]: true } as never);
      } else {
        editor.addStyles({ [style]: true } as never);
      }
    },
    [editor, state.activeStyles],
  );

  const setBlockType = useCallback(
    (type: SelectionBlockType, level?: HeadingLevel) => {
      editor.focus();
      const block = editor.getTextCursorPosition().block;
      if (!block) return;
      editor.updateBlock(block, (type === 'heading' ? { type, props: { level: level ?? 1 } } : { type }) as never);
      setOpenMenu(null);
    },
    [editor],
  );

  const applyColor = useCallback(
    (kind: 'textColor' | 'backgroundColor', value: string) => {
      editor.focus();
      editor.addStyles({ [kind]: value } as never);
      // A custom colour comes from dragging the picker: keep the menu open.
      if (!value.startsWith('#')) setOpenMenu(null);
    },
    [editor],
  );

  const submitLink = useCallback(() => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    const url = /^[a-z]+:\/\//i.test(trimmed) || trimmed.startsWith('mailto:') ? trimmed : `https://${trimmed}`;
    editor.focus();
    try {
      (editor as unknown as { createLink: (url: string) => void }).createLink(url);
    } catch { /* noop */ }
    setLinkMode(false);
    setLinkUrl('');
  }, [editor, linkUrl]);

  const askAgent = useCallback(() => {
    const text = readSelectedText(editor).trim();
    if (!text || !onAskAgent) return;
    onAskAgent(text);
    close();
  }, [editor, onAskAgent, close]);

  if (!anchor) return null;

  const { activeStyles, activeBlockType, activeHeadingLevel } = state;
  const codeBlockLabel = editor.dictionary.slash_menu.code_block.title;
  const blockItems: { type: SelectionBlockType; level?: HeadingLevel; label: string; Icon: typeof Pilcrow; match: boolean }[] = [
    { type: 'paragraph', label: st.body, Icon: Pilcrow, match: activeBlockType === 'paragraph' },
    { type: 'heading', level: 1, label: tb.blocks.heading1, Icon: Heading1, match: activeBlockType === 'heading' && activeHeadingLevel === 1 },
    { type: 'heading', level: 2, label: tb.blocks.heading2, Icon: Heading2, match: activeBlockType === 'heading' && activeHeadingLevel === 2 },
    { type: 'heading', level: 3, label: tb.blocks.heading3, Icon: Heading3, match: activeBlockType === 'heading' && activeHeadingLevel === 3 },
    { type: 'bulletListItem', label: tb.blocks.bulletList, Icon: List, match: activeBlockType === 'bulletListItem' },
    { type: 'numberedListItem', label: tb.blocks.numberedList, Icon: ListOrdered, match: activeBlockType === 'numberedListItem' },
    { type: 'checkListItem', label: tb.blocks.checkList, Icon: ListChecks, match: activeBlockType === 'checkListItem' },
    { type: 'quote', label: tb.blocks.quote, Icon: Quote, match: activeBlockType === 'quote' },
    { type: 'codeBlock', label: codeBlockLabel, Icon: SquareCode, match: activeBlockType === 'codeBlock' },
  ];
  const currentBlockLabel = blockItems.find((item) => item.match)?.label ?? st.body;

  const textColor = activeStyles.textColor as string | undefined;
  const textSwatch = TEXT_COLORS.find((c) => c.value === textColor && c.value !== 'default')?.swatch
    ?? (textColor?.startsWith('#') ? textColor : undefined);
  const highlight = activeStyles.backgroundColor as string | undefined;
  const highlightSwatch = BG_COLORS.find((c) => c.value === highlight && c.value !== 'default')?.swatch
    ?? (highlight?.startsWith('#') ? highlight : undefined);

  // Line up with the start of the selection, above it; flip below it when
  // there's no room above, and keep the whole bar on screen.
  const width = size.width || 360;
  const height = size.height || 36;
  const left = Math.min(
    Math.max(anchor.x, SELECTION_TOOLBAR_EDGE),
    window.innerWidth - width - SELECTION_TOOLBAR_EDGE,
  );
  const top = anchor.y - height - SELECTION_TOOLBAR_GAP;

  // Clicks on the bar and its menus must not take focus (and the selection)
  // away from the document; the link field is the one exception.
  const keepSelection = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('input')) return;
    e.preventDefault();
  };

  // Menus open and close instantly, like the bar itself (`animate-none!` on each).
  const menuContentProps = {
    onOpenAutoFocus: (e: Event) => e.preventDefault(),
    onCloseAutoFocus: (e: Event) => e.preventDefault(),
    onMouseDown: keepSelection,
  };

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      data-selection-toolbar
      className="fixed z-50 flex h-9 items-center gap-0.5 rounded-[10px] border bg-popover px-1 text-popover-foreground shadow-md"
      style={{ left, top: top < SELECTION_TOOLBAR_EDGE ? anchor.y + 28 : top }}
      onMouseDown={keepSelection}
    >
      {linkMode ? (
        <div className="flex items-center gap-1 px-1">
          <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitLink();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setLinkMode(false);
                editor.focus();
              }
            }}
            placeholder={st.linkPlaceholder}
            spellCheck={false}
            className="h-7 w-60 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={SELECTION_TEXT_BUTTON}
            onClick={submitLink}
            disabled={!linkUrl.trim()}
          >
            {tb.link.apply}
          </Button>
        </div>
      ) : (
        <>
          {onAskAgent ? (
            <>
              <Button type="button" variant="ghost" className={SELECTION_TEXT_BUTTON} onClick={askAgent}>
                <img src="/assets/images/weldagent/icon.svg" alt="" className="h-4 w-4" />
                <span>{st.askAgent}</span>
              </Button>
              <div className={SELECTION_SEPARATOR} />
            </>
          ) : null}

          <Popover open={openMenu === 'block'} onOpenChange={(open) => setOpenMenu(open ? 'block' : null)}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" className={SELECTION_TEXT_BUTTON} title={tb.blockType}>
                <span className="max-w-[110px] truncate">{currentBlockLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-48 p-1 animate-none!" {...menuContentProps}>
              {blockItems.map(({ type, level, label, Icon, match }) => (
                <Button
                  key={label}
                  type="button"
                  variant="ghost"
                  onClick={() => setBlockType(type, level)}
                  className={cn(
                    'h-8 w-full justify-start gap-2 rounded-[7px] px-2 text-sm font-normal',
                    match && 'bg-accent text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span>{label}</span>
                  <Check className={cn('ml-auto h-4 w-4', match ? 'opacity-100' : 'opacity-0')} />
                </Button>
              ))}
            </PopoverContent>
          </Popover>

          <div className={SELECTION_SEPARATOR} />

          <Popover open={openMenu === 'text'} onOpenChange={(open) => setOpenMenu(open ? 'text' : null)}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" className={SELECTION_TEXT_BUTTON} title={tb.textColor}>
                <span>{st.text}</span>
                <SelectionSwatch color={textSwatch} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-auto p-2 animate-none!" {...menuContentProps}>
              <SelectionColorMenu
                swatches={TEXT_COLORS}
                current={textColor}
                onPick={(value) => applyColor('textColor', value)}
              />
            </PopoverContent>
          </Popover>

          <Popover open={openMenu === 'highlight'} onOpenChange={(open) => setOpenMenu(open ? 'highlight' : null)}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" className={SELECTION_TEXT_BUTTON} title={tb.highlight}>
                <span>{st.highlight}</span>
                <SelectionSwatch color={highlightSwatch} none={!highlightSwatch} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="w-auto p-2 animate-none!" {...menuContentProps}>
              <SelectionColorMenu
                swatches={BG_COLORS}
                current={highlight}
                onPick={(value) => applyColor('backgroundColor', value)}
                highlight
              />
            </PopoverContent>
          </Popover>

          <div className={SELECTION_SEPARATOR} />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={SELECTION_ICON_BUTTON}
            title={tb.link.insertLink}
            onClick={() => setLinkMode(true)}
          >
            <LinkIcon className="h-4 w-4" />
          </Button>

          <div className={SELECTION_SEPARATOR} />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(SELECTION_ICON_BUTTON, activeStyles.bold && 'bg-accent text-foreground')}
            title={tb.bold}
            onClick={() => toggleStyle('bold')}
          >
            <BoldGlyph />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(SELECTION_ICON_BUTTON, activeStyles.italic && 'bg-accent text-foreground')}
            title={tb.italic}
            onClick={() => toggleStyle('italic')}
          >
            <ItalicGlyph />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(SELECTION_ICON_BUTTON, activeStyles.strike && 'bg-accent text-foreground')}
            title={tb.strikethrough}
            onClick={() => toggleStyle('strike')}
          >
            <Strikethrough className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>,
    document.body,
  );
}

export type {  PartialBlock };
