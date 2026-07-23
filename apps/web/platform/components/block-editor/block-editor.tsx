import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import { BlockNoteView } from '@blocknote/shadcn';
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  FloatingComposerController,
  FloatingThreadController,
} from '@blocknote/react';
import { filterSuggestionItems } from '@blocknote/core';
import { CommentsExtension } from '@blocknote/core/comments';
import { undoDepth, redoDepth } from 'prosemirror-history';
import {
  Block,
  BlockNoteSchema,
  createStyleSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
  PartialBlock,
} from '@blocknote/core';
import '@blocknote/shadcn/style.css';
import { cn } from '@/lib/utils';
import { useFileUpload } from '@/hooks/use-file-upload';
import {
  Bold,
  Italic,
  Underline,
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
  Indent,
  Outdent,
  Palette,
  Highlighter,
  RemoveFormatting,
  Pilcrow,
  ChevronDown,
  Check,
  Image as ImageIcon,
  Table as TableIcon,
  Minus,
  SquareCode,
  Type,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';

// ============================================================================
// BlockNote-based Notion-like document editor
// ============================================================================

// Custom style specs for font-family and font-size. BlockNote doesn't
// ship these by default; we register them as inline styles that render
// a <span> with the corresponding CSS so they round-trip through
// serialization and external HTML export.
const FontFamily = createStyleSpec(
  { type: 'fontFamily', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontFamily = String(value);
      return { dom: span, contentDOM: span };
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontFamily = String(value);
      return { dom: span, contentDOM: span };
    },
    parse: (el) => {
      if (el instanceof HTMLElement && el.style.fontFamily) return el.style.fontFamily;
      return undefined;
    },
  },
);

const FontSize = createStyleSpec(
  { type: 'fontSize', propSchema: 'string' },
  {
    render: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontSize = String(value);
      return { dom: span, contentDOM: span };
    },
    toExternalHTML: (value) => {
      const span = document.createElement('span');
      if (value) span.style.fontSize = String(value);
      return { dom: span, contentDOM: span };
    },
    parse: (el) => {
      if (el instanceof HTMLElement && el.style.fontSize) return el.style.fontSize;
      return undefined;
    },
  },
);

// Map BlockNote's default slash-menu titles → Lucide icon components
// so every row in the / menu renders a consistent icon from lucide.dev.
const SLASH_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  'Heading 1': Heading1,
  'Heading 2': Heading2,
  'Heading 3': Heading3,
  'Paragraph': Pilcrow,
  'Quote': Quote,
  'Numbered List': ListOrdered,
  'Bullet List': List,
  'Check List': ListChecks,
  'Code Block': SquareCode,
  'Divider': Minus,
  'Table': TableIcon,
  'Image': ImageIcon,
  'Heading': Type,
};

// Restrict block specs to those with native DOCX equivalents so documents
// always survive a Word / Google Docs round-trip without sidecar metadata.
// Dropped: audio, video, file, embed, toggle (no DOCX equivalent), and the
// WeldSuite-custom pageLink inline content (cross-doc linking has no DOCX
// equivalent; use plain hyperlinks instead).
const DOCX_SAFE_BLOCK_SPECS: (keyof typeof defaultBlockSpecs)[] = [
  'paragraph',
  'heading',
  'bulletListItem',
  'numberedListItem',
  'checkListItem',
  'quote',
  'codeBlock',
  'table',
  'image',
  'divider',
];

// Build a block-spec map that only contains the DOCX-safe entries.
const docxBlockSpecs = Object.fromEntries(
  DOCX_SAFE_BLOCK_SPECS
    .filter((k) => k in defaultBlockSpecs)
    .map((k) => [k, defaultBlockSpecs[k]]),
) as typeof defaultBlockSpecs;

const schema = BlockNoteSchema.create({
  blockSpecs: docxBlockSpecs,
  inlineContentSpecs: defaultInlineContentSpecs,
  styleSpecs: {
    ...defaultStyleSpecs,
    fontFamily: FontFamily,
    fontSize: FontSize,
  },
});

/** Imperative handle exposed via ref */
export interface BlockEditorHandle {
  /** Replace the entire editor content with new blocks */
  replaceContent: (blocks: PartialBlock[]) => void;
}

export interface BlockEditorProps {
  /** Initial content as BlockNote JSON blocks */
  initialContent?: PartialBlock[];
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
}

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
}, ref) {
  const { uploadFile } = useFileUpload({
    folder: 'documents/content',
    maxFileSize: 10 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    entityType: 'project-document',
    entityId: entityId || projectId || '',
    isPublic: true,
  });

  const handleUploadFile = useCallback(
    async (file: File): Promise<string> => {
      const result = await uploadFile(file);
      return result?.url || '';
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
      // In collaborative mode the Yjs fragment is the source of truth, so we
      // must NOT also pass initialContent (it would conflict with sync).
      initialContent: collaboration ? undefined : (resolvedInitialContent as any),
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

  // Flag to suppress onChange during remote content replacement
  const isRemoteUpdateRef = useRef(false);

  // Expose imperative handle for remote content updates
  useImperativeHandle(ref, () => ({
    replaceContent: (blocks: PartialBlock[]) => {
      isRemoteUpdateRef.current = true;
      try {
        editor.replaceBlocks(editor.document, blocks as any);
      } finally {
        // Reset after a tick so the onChange from replaceBlocks is suppressed
        setTimeout(() => { isRemoteUpdateRef.current = false; }, 0);
      }
    },
  }), [editor]);

  // Convert HTML to blocks if initialHtml is provided and no JSON content
  useEffect(() => {
    if (initialHtml && (!initialContent || initialContent.length === 0)) {
      async function convert() {
        try {
          const blocks = await editor.tryParseHTMLToBlocks(initialHtml!);
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

  const handleChange = useCallback(() => {
    if (isRemoteUpdateRef.current) return; // Skip onChange triggered by remote replaceContent
    if (onContentChange) {
      onContentChange(editor.document as unknown as Block[]);
    }
  }, [editor, onContentChange]);

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


  // Titles of blocks NOT in our DOCX-safe set — filtered out of the slash menu.
  const DOCX_SAFE_SLASH_TITLES = new Set([
    'Heading 1', 'Heading 2', 'Heading 3', 'Paragraph',
    'Quote', 'Numbered List', 'Bullet List', 'Check List',
    'Code Block', 'Table', 'Image', 'Divider',
  ]);

  return (
    <div className={cn('block-editor-wrapper', className)}>
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
        // that remaps every icon to Lucide. Without this, BOTH menus
        // would register on the same trigger character and clicks on
        // our menu's items got intercepted by the default's handler.
        slashMenu={false}
        data-theming-css-variables-demo
      >
        {/* / trigger — only expose DOCX-safe block types, swap icons for Lucide */}
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              getDefaultReactSlashMenuItems(editor)
                .filter((item) => DOCX_SAFE_SLASH_TITLES.has(item.title))
                .map((item) => {
                  const Icon = SLASH_ICON_MAP[item.title];
                  return Icon
                    ? { ...item, icon: <Icon className="h-4 w-4" /> }
                    : item;
                }),
              query,
            )
          }
        />
        {/* Comment threads (collaborative): floating composer when adding a
            comment on a selection, and the thread card when one is clicked. */}
        {comments ? (
          <>
            <FloatingComposerController />
            <FloatingThreadController />
          </>
        ) : null}
      </BlockNoteView>
    </div>
  );
});

// ============================================================================
// Static formatting toolbar (always visible at top of editor)
// ============================================================================

type BasicStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
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

const TEXT_COLORS: { value: string; label: string; swatch: string }[] = [
  { value: 'default', label: 'Default', swatch: '#111827' },
  { value: 'gray', label: 'Gray', swatch: '#6b7280' },
  { value: 'slate', label: 'Slate', swatch: '#475569' },
  { value: 'stone', label: 'Stone', swatch: '#78716c' },
  { value: 'brown', label: 'Brown', swatch: '#92400e' },
  { value: 'red', label: 'Red', swatch: '#dc2626' },
  { value: 'rose', label: 'Rose', swatch: '#e11d48' },
  { value: 'pink', label: 'Pink', swatch: '#db2777' },
  { value: 'fuchsia', label: 'Fuchsia', swatch: '#c026d3' },
  { value: 'purple', label: 'Purple', swatch: '#9333ea' },
  { value: 'violet', label: 'Violet', swatch: '#7c3aed' },
  { value: 'indigo', label: 'Indigo', swatch: '#4f46e5' },
  { value: 'blue', label: 'Blue', swatch: '#2563eb' },
  { value: 'sky', label: 'Sky', swatch: '#0284c7' },
  { value: 'cyan', label: 'Cyan', swatch: '#0891b2' },
  { value: 'teal', label: 'Teal', swatch: '#0d9488' },
  { value: 'emerald', label: 'Emerald', swatch: '#059669' },
  { value: 'green', label: 'Green', swatch: '#16a34a' },
  { value: 'lime', label: 'Lime', swatch: '#65a30d' },
  { value: 'yellow', label: 'Yellow', swatch: '#ca8a04' },
  { value: 'amber', label: 'Amber', swatch: '#d97706' },
  { value: 'orange', label: 'Orange', swatch: '#ea580c' },
  { value: 'zinc', label: 'Zinc', swatch: '#52525b' },
  { value: 'neutral', label: 'Neutral', swatch: '#525252' },
];

const BG_COLORS: { value: string; label: string; swatch: string }[] = [
  { value: 'default', label: 'None', swatch: '#ffffff' },
  { value: 'gray', label: 'Gray', swatch: '#e5e7eb' },
  { value: 'slate', label: 'Slate', swatch: '#cbd5e1' },
  { value: 'stone', label: 'Stone', swatch: '#d6d3d1' },
  { value: 'brown', label: 'Brown', swatch: '#fde4c9' },
  { value: 'red', label: 'Red', swatch: '#fecaca' },
  { value: 'rose', label: 'Rose', swatch: '#fecdd3' },
  { value: 'pink', label: 'Pink', swatch: '#fbcfe8' },
  { value: 'fuchsia', label: 'Fuchsia', swatch: '#f5d0fe' },
  { value: 'purple', label: 'Purple', swatch: '#e9d5ff' },
  { value: 'violet', label: 'Violet', swatch: '#ddd6fe' },
  { value: 'indigo', label: 'Indigo', swatch: '#c7d2fe' },
  { value: 'blue', label: 'Blue', swatch: '#bfdbfe' },
  { value: 'sky', label: 'Sky', swatch: '#bae6fd' },
  { value: 'cyan', label: 'Cyan', swatch: '#a5f3fc' },
  { value: 'teal', label: 'Teal', swatch: '#99f6e4' },
  { value: 'emerald', label: 'Emerald', swatch: '#a7f3d0' },
  { value: 'green', label: 'Green', swatch: '#bbf7d0' },
  { value: 'lime', label: 'Lime', swatch: '#d9f99d' },
  { value: 'yellow', label: 'Yellow', swatch: '#fde68a' },
  { value: 'amber', label: 'Amber', swatch: '#fcd34d' },
  { value: 'orange', label: 'Orange', swatch: '#fed7aa' },
  { value: 'zinc', label: 'Zinc', swatch: '#e4e4e7' },
  { value: 'neutral', label: 'Neutral', swatch: '#e5e5e5' },
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
  const px = parseFloat(size);
  return Number.isFinite(px) ? `${Math.round(px)}px` : '16px';
}

export function StaticFormattingToolbar({ editor }: { editor: BlockNoteEditorInstance }) {
  const [state, setState] = useState<ToolbarState>(INITIAL_TOOLBAR_STATE);
  const { activeStyles, activeBlockType, activeHeadingLevel, activeTextAlignment } = state;
  const lastStateRef = useRef<ToolbarState>(INITIAL_TOOLBAR_STATE);

  useEffect(() => {
    const compute = (): ToolbarState => {
      try {
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

        const tt = (editor as unknown as {
          _tiptapEditor?: {
            isActive?: (name: string) => boolean;
            getAttributes?: (name: string) => Record<string, unknown>;
          };
        })._tiptapEditor;

        if (tt?.isActive) {
          for (const markName of ['bold', 'italic', 'underline', 'strike', 'code']) {
            if (tt.isActive(markName)) activeStyles[markName] = true;
          }
          for (const markName of ['textColor', 'backgroundColor', 'fontFamily', 'fontSize']) {
            if (tt.isActive(markName)) {
              const attrs = tt.getAttributes?.(markName) ?? {};
              const val = (attrs as { stringValue?: string }).stringValue;
              if (typeof val === 'string' && val.length > 0) {
                activeStyles[markName] = val;
              }
            }
          }
        }

        const inside = selectionInsideEditor();
        const block = editor.getTextCursorPosition().block;
        const props = (block as { props?: Record<string, unknown> } | undefined)?.props;

        // Read undo / redo history depths directly from the
        // prosemirror-history plugin. `editor.can().undo()` through
        // TipTap's wrapper returned false even with history present,
        // so we go to the source: the plugin's own state.
        let canUndo = false;
        let canRedo = false;
        try {
          const pmState = (editor as unknown as { _tiptapEditor?: { state: unknown } })._tiptapEditor?.state;
          if (pmState) {
            canUndo = undoDepth(pmState as never) > 0;
            canRedo = redoDepth(pmState as never) > 0;
          }
        } catch {
          /* noop */
        }

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
          ...lastStateRef.current,
          effectiveFontSize: readEffectiveFontSize(),
          caretInsideEditor: selectionInsideEditor(),
        };
      }
    };

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
    (
      type: 'paragraph' | 'heading' | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote',
      level?: 1 | 2 | 3,
    ) => {
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

      const tt = (editor as unknown as { _tiptapEditor?: {
        state: { selection: { empty: boolean } };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chain: () => any;
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

  const btn = (isActive: boolean) =>
    cn(
      'h-7 w-7 flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
      isActive && 'bg-accent text-foreground',
    );

  const currentBlockLabel = (() => {
    if (activeBlockType === 'heading' && activeHeadingLevel) return `Heading ${activeHeadingLevel}`;
    if (activeBlockType === 'quote') return 'Quote';
    if (activeBlockType === 'bulletListItem') return 'Bullet list';
    if (activeBlockType === 'numberedListItem') return 'Numbered list';
    if (activeBlockType === 'checkListItem') return 'Check list';
    return 'Paragraph';
  })();

  const alignIcon = (a: TextAlignment) =>
    a === 'center' ? AlignCenter : a === 'right' ? AlignRight : a === 'justify' ? AlignJustify : AlignLeft;
  const AlignCurrent = alignIcon(activeTextAlignment);

  return (
    <TooltipProvider delayDuration={10000} skipDelayDuration={300}>
    <div
      className="flex items-center gap-0.5 flex-wrap"
      // Keep the caret inside the document when clicking any toolbar
      // control — the browser's default mousedown behaviour moves focus
      // to the clicked button and collapses the editor selection. Skip
      // this for anything rendered inside a Popover/Dropdown, so the
      // search input and menu items inside those menus can receive
      // focus and clicks normally (popovers propagate React events back
      // through the component tree even though they render in a portal).
      onMouseDown={(e) => {
        const target = e.target as Element | null;
        if (target?.closest('[data-slot="popover-content"], [data-slot="dropdown-menu-content"]')) {
          return;
        }
        e.preventDefault();
      }}
    >
      {/* Undo / Redo */}
      <TT label="Undo">
        <Button
          variant="ghost"
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
      </TT>
      <TT label="Redo">
        <Button
          variant="ghost"
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
      </TT>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Block type — Popover instead of DropdownMenu so opening the
          menu doesn't yank the caret out of the document. */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className="h-[30px] px-2 flex items-center gap-1 text-sm rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title="Block type"
          >
            <span className="truncate max-w-[110px]">{currentBlockLabel}</span>
            <ChevronDown className="h-3 w-3" />
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
              { type: 'paragraph' as const, label: 'Paragraph', Icon: Pilcrow, match: activeBlockType === 'paragraph' },
              { type: 'heading' as const, level: 1 as const, label: 'Heading 1', Icon: Heading1, match: activeBlockType === 'heading' && activeHeadingLevel === 1 },
              { type: 'heading' as const, level: 2 as const, label: 'Heading 2', Icon: Heading2, match: activeBlockType === 'heading' && activeHeadingLevel === 2 },
              { type: 'heading' as const, level: 3 as const, label: 'Heading 3', Icon: Heading3, match: activeBlockType === 'heading' && activeHeadingLevel === 3 },
              { type: null, label: '__separator__', Icon: null as never, match: false },
              { type: 'bulletListItem' as const, label: 'Bullet list', Icon: List, match: activeBlockType === 'bulletListItem' },
              { type: 'numberedListItem' as const, label: 'Numbered list', Icon: ListOrdered, match: activeBlockType === 'numberedListItem' },
              { type: 'checkListItem' as const, label: 'Check list', Icon: ListChecks, match: activeBlockType === 'checkListItem' },
              { type: 'quote' as const, label: 'Quote', Icon: Quote, match: activeBlockType === 'quote' },
            ];
            return items.map((item, idx) => {
              if (item.label === '__separator__') {
                return <div key={idx} className="my-1 h-px bg-border" />;
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

      <div className="w-px h-5 bg-border mx-1" />

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
            className="h-[30px] px-2 flex items-center gap-1 text-sm rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title="Font size"
          >
            <span className="tabular-nums">
              {state.caretInsideEditor && activeStyles.fontSize
                ? (activeStyles.fontSize as string)
                : state.effectiveFontSize}
            </span>
            <ChevronDown className="h-3 w-3" />
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

      <div className="w-px h-5 bg-border mx-1" />

      {/* Inline styles */}
      <TT label="Bold (⌘B)">
        <Button variant="ghost" type="button" className={btn(!!activeStyles.bold)} onClick={() => toggleStyle('bold')}>
          <Bold className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Italic (⌘I)">
        <Button variant="ghost" type="button" className={btn(!!activeStyles.italic)} onClick={() => toggleStyle('italic')}>
          <Italic className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Underline (⌘U)">
        <Button variant="ghost" type="button" className={btn(!!activeStyles.underline)} onClick={() => toggleStyle('underline')}>
          <Underline className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Strikethrough">
        <Button variant="ghost" type="button" className={btn(!!activeStyles.strike)} onClick={() => toggleStyle('strike')}>
          <Strikethrough className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Inline code">
        <Button variant="ghost" type="button" className={btn(!!activeStyles.code)} onClick={() => toggleStyle('code')}>
          <Code className="h-4 w-4" />
        </Button>
      </TT>

      {/* Text color */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className="h-[30px] w-[30px] flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title="Text color"
          >
            <Palette className="h-4 w-4" />
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
            type="button"
            className="h-[30px] w-[30px] flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title="Highlight"
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

      <div className="w-px h-5 bg-border mx-1" />

      {/* Alignment — Popover instead of DropdownMenu so we can prevent
          focus from ever leaving the editor. DropdownMenu moves focus
          to the menu content on open for keyboard nav, which yanks the
          caret out of the document. */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            type="button"
            className="h-[30px] w-[30px] flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors data-[state=open]:bg-accent data-[state=open]:text-foreground"
            title="Alignment"
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
            { value: 'left', label: 'Left', Icon: AlignLeft },
            { value: 'center', label: 'Center', Icon: AlignCenter },
            { value: 'right', label: 'Right', Icon: AlignRight },
            { value: 'justify', label: 'Justify', Icon: AlignJustify },
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
      <TT label="Bullet list">
        <Button variant="ghost" type="button" className={btn(activeBlockType === 'bulletListItem')} onClick={() => setBlockType('bulletListItem')}>
          <List className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Numbered list">
        <Button variant="ghost" type="button" className={btn(activeBlockType === 'numberedListItem')} onClick={() => setBlockType('numberedListItem')}>
          <ListOrdered className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Check list">
        <Button variant="ghost" type="button" className={btn(activeBlockType === 'checkListItem')} onClick={() => setBlockType('checkListItem')}>
          <ListChecks className="h-4 w-4" />
        </Button>
      </TT>

      {/* Indent / Outdent */}
      <TT label="Increase indent">
        <Button variant="ghost" type="button" className={btn(false)} onClick={nestBlock}>
          <Indent className="h-4 w-4" />
        </Button>
      </TT>
      <TT label="Decrease indent">
        <Button variant="ghost" type="button" className={btn(false)} onClick={unnestBlock}>
          <Outdent className="h-4 w-4" />
        </Button>
      </TT>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Add comment (collaborative documents only) */}
      {hasComments && (
        <TT label="Add comment">
          <Button variant="ghost" type="button" className={btn(false)} onClick={addComment}>
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </TT>
      )}

      {/* Clear formatting */}
      <TT label="Clear formatting">
        <Button variant="ghost" type="button" className={btn(false)} onClick={clearFormatting}>
          <RemoveFormatting className="h-4 w-4" />
        </Button>
      </TT>
    </div>
    </TooltipProvider>
  );
}

function TT({ label, children }: { label: string; children: React.ReactElement }) {
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
}: {
  currentFamily: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          className="h-[30px] px-2 flex items-center gap-1 text-sm rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title="Font"
        >
          <span className="truncate max-w-[90px]">
            {FONT_FAMILIES.find((f) => f.value === currentFamily)?.label || 'Default'}
          </span>
          <ChevronDown className="h-3 w-3" />
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
          <CommandInput placeholder="Search fonts..." />
          <CommandList>
            <CommandEmpty>No fonts match.</CommandEmpty>
            <CommandGroup className="pl-1 pr-0 py-1">
              {FONT_FAMILIES.map((f) => (
                <CommandItem
                  key={f.label}
                  value={f.label}
                  onSelect={() => {
                    onPick(f.value);
                    setOpen(false);
                  }}
                  style={{ fontFamily: f.value || undefined }}
                  className={cn(
                    f.value === currentFamily && 'bg-accent text-accent-foreground',
                  )}
                >
                  <span>{f.label}</span>
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
}: {
  swatches: { value: string; label: string; swatch: string }[];
  current: string | undefined;
  onPick: (value: string) => void;
  swatchBorder?: boolean;
  checkIconClass: string;
}) {
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
            ← Back
          </Button>
          <span className="text-xs text-muted-foreground">Custom color</span>
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
            title={c.label}
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
        title="Custom color"
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
}: {
  onApply: (url: string, text?: string) => void;
  getSelectionText: () => string;
}) {
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
          type="button"
          className="h-[30px] w-[30px] flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title="Insert link"
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
          <h4 className="font-medium text-sm leading-none">Insert link</h4>

          <div className="grid gap-2">
            {!hadSelection && (
              <div className="grid grid-cols-[70px_1fr] items-center gap-3">
                <Label htmlFor="link-text" className="text-xs">Text</Label>
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
                  placeholder="Link text"
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
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type {  PartialBlock };
