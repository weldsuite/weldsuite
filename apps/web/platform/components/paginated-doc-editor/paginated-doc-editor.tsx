import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link2,
  Undo2,
  Redo2,
  RemoveFormatting,
  Pilcrow,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  ChevronDown,
  Baseline,
  Highlighter,
  IndentIncrease,
  IndentDecrease,
  ListChecks,
  AlignVerticalSpaceAround,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { useTranslations } from '@weldsuite/i18n/client';
import { PaginatedDocMenubar, type DocCommand, type DocActions } from './menubar';

// ---------------------------------------------------------------------------
// Standalone paginated document editor — plain contenteditable, no BlockNote.
//
// The document is a single contenteditable holding top-level block elements
// (<p>, <h1>..<h3>, <ul>, <ol>). A4 "paper" cards are painted behind it; the
// content flows in normal document flow ON TOP and defines the column height
// (so it can never spill onto grey). After each change we measure the blocks
// and push any block that crosses a page's content bottom down to the top of
// the next page — a real page break between blocks (we don't split a single
// block mid-way; that needs a layout engine / paid extension).
//
// Because we own these plain elements, the push margin applies directly (no
// framework !important rules to fight).
// ---------------------------------------------------------------------------

const MM_TO_PX = 96 / 25.4;
const PAGE_WIDTH_PX = Math.round(210 * MM_TO_PX);
const PAGE_HEIGHT_PX = Math.round(297 * MM_TO_PX);
const PAGE_PADDING_PX = Math.round(25.4 * MM_TO_PX);
const PAGE_GAP_PX = 16;
const CONTENT_AREA_PX = PAGE_HEIGHT_PX - 2 * PAGE_PADDING_PX;
const PAGE_STRIDE_PX = PAGE_HEIGHT_PX + PAGE_GAP_PX;

export interface PaginatedDocEditorHandle {
  /** Replace the entire document content. */
  setHtml: (html: string) => void;
  /** Read the current document HTML. */
  getHtml: () => string;
}

export interface PaginatedDocEditorProps {
  initialHtml?: string;
  editable?: boolean;
  /** Fired (raw, not debounced) on every content change. */
  onChange?: (html: string) => void;
  /** Extra controls rendered on the right of the menu bar (e.g. back/expand). */
  toolbarExtra?: ReactNode;
  /** Optional document-level menu actions (rename/delete/save-now). */
  actions?: DocActions;
  className?: string;
}

const EMPTY_DOC = '<p><br></p>';

export const PaginatedDocEditor = forwardRef<PaginatedDocEditorHandle, PaginatedDocEditorProps>(
  function PaginatedDocEditor({ initialHtml, editable = true, onChange, toolbarExtra, actions, className }, ref) {
    const t = useTranslations();
    const editorRef = useRef<HTMLDivElement>(null);
    const [pageCount, setPageCount] = useState(1);
    const [tb, setTb] = useState<ToolbarState>(INITIAL_TOOLBAR_STATE);
    const onChangeRef = useRef(onChange);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    // When a font size is chosen with no text selected, the size must apply to
    // the *next* typed text (Google-Docs behaviour). The browser leaves a
    // legacy `size="7"` typing state; we remember the real pt here and rewrite
    // the <font> the next keystroke produces (see handleInput).
    const pendingFontSizeRef = useRef<number | null>(null);

    // Seed initial content once (uncontrolled — React must not re-set innerHTML
    // on every render or it would clobber the caret).
    const seededRef = useRef(false);
    useEffect(() => {
      const el = editorRef.current;
      if (!el || seededRef.current) return;
      el.innerHTML = initialHtml && initialHtml.trim() ? initialHtml : EMPTY_DOC;
      seededRef.current = true;
      // initial pagination pass
      requestAnimationFrame(() => repaginateRef.current?.());
    }, [initialHtml]);

    useImperativeHandle(ref, () => ({
      setHtml: (html: string) => {
        const el = editorRef.current;
        if (!el) return;
        el.innerHTML = html && html.trim() ? html : EMPTY_DOC;
        repaginateRef.current?.();
      },
      getHtml: () => editorRef.current?.innerHTML ?? '',
    }), []);

    // ---- Pagination ----
    const repaginateRef = useRef<(() => void) | null>(null);

    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;

      let ignore = false;
      let raf = 0;

      const repaginate = () => {
        const blocks = Array.from(el.children) as HTMLElement[];
        for (const b of blocks) {
          if (b.dataset.pgnPushed) {
            b.style.removeProperty('margin-top');
            delete b.dataset.pgnPushed;
          }
        }
        if (blocks.length === 0) {
          setPageCount(1);
          return;
        }

        const top0 = () => el.getBoundingClientRect().top;
        let pageStart = blocks[0].getBoundingClientRect().top - top0();
        let pages = 1;

        for (const block of blocks) {
          const r = block.getBoundingClientRect();
          const top = r.top - top0();
          const bottom = r.bottom - top0();
          const pageEnd = pageStart + CONTENT_AREA_PX;
          if (bottom > pageEnd + 1 && top > pageStart + 1) {
            const pushBy = pageEnd - top + PAGE_PADDING_PX + PAGE_GAP_PX + PAGE_PADDING_PX;
            block.style.setProperty('margin-top', `${Math.max(0, pushBy)}px`, 'important');
            block.dataset.pgnPushed = '1';
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            el.offsetHeight;
            pageStart = block.getBoundingClientRect().top - top0();
            pages++;
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        el.offsetHeight;
        const height = el.getBoundingClientRect().height;
        const byHeight = Math.max(1, Math.ceil((height + PAGE_GAP_PX) / PAGE_STRIDE_PX));
        setPageCount(Math.max(pages, byHeight));
      };
      repaginateRef.current = repaginate;

      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          ignore = true;
          try {
            repaginate();
          } finally {
            requestAnimationFrame(() => { ignore = false; });
          }
        });
      };

      const mo = new MutationObserver(() => { if (!ignore) schedule(); });
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      const ro = new ResizeObserver(() => { if (!ignore) schedule(); });
      ro.observe(el);
      schedule();

      return () => {
        mo.disconnect();
        ro.disconnect();
        repaginateRef.current = null;
        if (raf) cancelAnimationFrame(raf);
      };
    }, []);

    const handleInput = useCallback(() => {
      const el = editorRef.current;
      // Collapsed-selection font size: convert the <font size="7"> that the
      // browser just typed into a real pt size, in place.
      if (el && pendingFontSizeRef.current != null) {
        const pt = pendingFontSizeRef.current;
        el.querySelectorAll('font[size="7"]').forEach((f) => {
          const fe = f as HTMLElement;
          fe.removeAttribute('size');
          fe.style.fontSize = `${pt}pt`;
        });
      }
      onChangeRef.current?.(el?.innerHTML ?? '');
    }, []);

    // ---- Selection persistence ----
    // Menu-bar items live in a Radix popover, so opening one moves focus out
    // of the contenteditable and execCommand would have no range to act on.
    // We stash the last in-editor selection on blur and restore it before
    // running a command. Toolbar buttons preventDefault on mousedown, so the
    // editor stays focused there and we keep the live selection untouched.
    const savedRange = useRef<Range | null>(null);
    const refreshToolbarRef = useRef<() => void>(() => {});
    const saveSelection = useCallback(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (editorRef.current?.contains(range.commonAncestorContainer)) {
        savedRange.current = range.cloneRange();
      }
    }, []);
    const restoreSelection = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      if (document.activeElement === el) return; // live selection is current
      el.focus();
      const range = savedRange.current;
      if (range) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }, []);

    // ---- Command surface (execCommand — reliable inside contenteditable) ----
    const exec = useCallback((command: string, value?: string) => {
      restoreSelection();
      document.execCommand(command, false, value);
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection]);

    const setBlock = useCallback((tag: string) => {
      exec('formatBlock', tag);
    }, [exec]);

    // ---- Color commands ----
    // foreColor / hiliteColor need styleWithCSS enabled to (a) make hiliteColor
    // work in Chromium at all and (b) emit inline `style="..."` spans instead of
    // deprecated <font color>. We flip it on for the command and back off after.
    const applyColor = useCallback((command: 'foreColor' | 'hiliteColor', color: string) => {
      restoreSelection();
      try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* noop */ }
      document.execCommand(command, false, color);
      try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* noop */ }
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection]);

    // Apply a font family to the selection (styleWithCSS → inline `style` spans).
    const applyFontName = useCallback((family: string) => {
      restoreSelection();
      try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* noop */ }
      document.execCommand('fontName', false, family);
      try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* noop */ }
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection]);

    // execCommand('fontSize') only understands the legacy 1–7 scale, so we let
    // it split/wrap the exact selection (the hard part) as <font size="7">,
    // then rewrite those wrappers to a real pt value AND strip any nested
    // font-size so the wrapper's size actually wins — otherwise re-sizing text
    // that already had a size would do nothing (a child font-size overrides its
    // parent). Returns the rewritten wrappers, in document order.
    const normalizeFontSizeWrappers = useCallback((pt: number): HTMLElement[] => {
      const el = editorRef.current;
      if (!el) return [];
      const wrappers = Array.from(el.querySelectorAll('font[size="7"]')) as HTMLElement[];
      for (const w of wrappers) {
        w.removeAttribute('size');
        w.style.fontSize = `${pt}pt`;
        w.querySelectorAll<HTMLElement>('[style*="font-size"]').forEach((child) => {
          child.style.removeProperty('font-size');
          if (!child.getAttribute('style')) child.removeAttribute('style');
        });
      }
      return wrappers;
    }, []);

    const applyFontSize = useCallback((pt: number) => {
      restoreSelection();
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      const collapsed = !sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed;

      pendingFontSizeRef.current = null;

      // styleWithCSS off → execCommand emits the <font size="7"> sentinels.
      try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* noop */ }
      document.execCommand('fontSize', false, '7');

      if (collapsed) {
        // Nothing selected: apply to the next typed text (handleInput rewrites
        // it). Reflect the choice in the toolbar immediately.
        pendingFontSizeRef.current = pt;
        setTb((prev) => ({ ...prev, fontSize: pt }));
        handleInput();
        return;
      }

      const wrappers = normalizeFontSizeWrappers(pt);

      // Keep the same run selected so the size can be nudged repeatedly and the
      // highlight stays — exactly like Google Docs.
      if (wrappers.length && sel) {
        const range = document.createRange();
        range.setStartBefore(wrappers[0]);
        range.setEndAfter(wrappers[wrappers.length - 1]);
        sel.removeAllRanges();
        sel.addRange(range);
        savedRange.current = range.cloneRange();
      }
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection, normalizeFontSizeWrappers]);

    // Indent / outdent — styleWithCSS makes these adjust margin-left on the
    // block instead of wrapping it in <blockquote>.
    const indentBlock = useCallback((direction: 'indent' | 'outdent') => {
      restoreSelection();
      try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* noop */ }
      document.execCommand(direction);
      try { document.execCommand('styleWithCSS', false, 'false'); } catch { /* noop */ }
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection]);

    // Run a mutation against every top-level block the selection touches —
    // used for line-height and paragraph spacing (block-level CSS).
    const forEachSelectedBlock = useCallback((fn: (b: HTMLElement) => void) => {
      restoreSelection();
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      (Array.from(el.children) as HTMLElement[]).forEach((b) => {
        if (range.intersectsNode(b)) fn(b);
      });
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection]);

    const setLineHeight = useCallback((lh: string) => {
      forEachSelectedBlock((b) => { b.style.lineHeight = lh; });
    }, [forEachSelectedBlock]);

    // Toggle a standard before/after gap on the selected paragraphs.
    const toggleBlockSpacing = useCallback((side: 'top' | 'bottom') => {
      const css = side === 'top' ? 'margin-top' : 'margin-bottom';
      forEachSelectedBlock((b) => {
        if (b.style.getPropertyValue(css)) b.style.removeProperty(css);
        else b.style.setProperty(css, '12pt');
      });
    }, [forEachSelectedBlock]);

    // Checklist: a <ul class="pgn-checklist"> whose <li>s carry a `data-checked`
    // flag (rendered via CSS ::before/::after, persisted in the saved HTML).
    const findListAncestor = useCallback((): HTMLElement | null => {
      const el = editorRef.current;
      const sel = window.getSelection();
      let node: Node | null = sel?.anchorNode ?? null;
      while (node && node !== el) {
        if (node instanceof HTMLElement && node.tagName === 'UL') return node;
        node = node.parentNode;
      }
      return null;
    }, []);

    const toggleChecklist = useCallback(() => {
      restoreSelection();
      const el = editorRef.current;
      if (!el) return;
      const ul = findListAncestor();
      if (ul) {
        if (ul.classList.contains('pgn-checklist')) {
          // Already a checklist → unwrap back to paragraphs.
          ul.querySelectorAll('li').forEach((li) => li.removeAttribute('data-checked'));
          document.execCommand('insertUnorderedList');
        } else {
          // Plain bullet list → promote to checklist.
          ul.classList.add('pgn-checklist');
        }
      } else {
        document.execCommand('insertUnorderedList');
        const created = findListAncestor();
        created?.classList.add('pgn-checklist');
      }
      handleInput();
      refreshToolbarRef.current();
    }, [handleInput, restoreSelection, findListAncestor]);

    // Click within a checklist item's marker zone toggles its checked state.
    const handleEditorClick = useCallback((e: React.MouseEvent) => {
      if (!editable) return;
      const target = e.target as HTMLElement;
      const li = target.closest('li');
      if (li && li.parentElement?.classList.contains('pgn-checklist')) {
        const rect = li.getBoundingClientRect();
        if (e.clientX - rect.left <= 22) {
          if (li.hasAttribute('data-checked')) li.removeAttribute('data-checked');
          else li.setAttribute('data-checked', '');
          handleInput();
        }
      }
    }, [editable, handleInput]);

    const cmd: DocCommand = useMemo(() => ({
      exec,
      setBlock,
      insertLink: () => {
        const url = window.prompt(t('sweep.entities.docToolbarLinkUrlPrompt'), 'https://');
        if (url) exec('createLink', url);
      },
      insertText: (text: string) => exec('insertText', text),
      print: () => window.print(),
      downloadHtml: () => {
        const body = editorRef.current?.innerHTML ?? '';
        const name = (actions?.fileName || 'document').replace(/[^\w.-]+/g, '_');
        const full = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${name}</title></head><body>${body}</body></html>`;
        const blob = new Blob([full], { type: 'text/html' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${name}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      },
      toggleFullscreen: () => {
        try {
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen();
        } catch { /* noop */ }
      },
    }), [exec, setBlock, actions?.fileName, t]);

    // Map the block-type dropdown choices onto the underlying commands.
    const applyBlock = useCallback((kind: BlockKind) => {
      switch (kind) {
        case 'paragraph': setBlock('P'); break;
        case 'heading1': setBlock('H1'); break;
        case 'heading2': setBlock('H2'); break;
        case 'heading3': setBlock('H3'); break;
        case 'quote': setBlock('BLOCKQUOTE'); break;
        case 'bulletList': exec('insertUnorderedList'); break;
        case 'numberedList': exec('insertOrderedList'); break;
      }
    }, [setBlock, exec]);

    // ---- Toolbar active-state tracking ----
    // Mirror the live selection's formatting onto the toolbar (so Bold lights
    // up inside bold text, the block-type label reflects the current block,
    // etc.) — matching the original BlockNote toolbar's behaviour, but read
    // from `queryCommandState` + the selection's top-level block element.
    const refreshToolbar = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;

      // Walk up to the editor's direct child — that's the "block".
      let node: Node | null = sel.anchorNode;
      let blockEl: HTMLElement | null = null;
      while (node && node !== el) {
        if (node.parentNode === el && node instanceof HTMLElement) { blockEl = node; break; }
        node = node.parentNode;
      }
      const tag = blockEl?.tagName ?? 'P';
      const block: BlockKind =
        tag === 'H1' ? 'heading1'
        : tag === 'H2' ? 'heading2'
        : tag === 'H3' ? 'heading3'
        : tag === 'UL' ? 'bulletList'
        : tag === 'OL' ? 'numberedList'
        : tag === 'BLOCKQUOTE' ? 'quote'
        : 'paragraph';

      // Current font family + size, read from the element at the selection's
      // start (the actual styled text — not just the parent block), so the
      // toolbar mirrors the caret/selection like Bold/Italic do.
      let fontName = 'Arial';
      let fontSize = 11;
      const range = sel.getRangeAt(0);
      let probe: Node | null = range.startContainer;
      if (probe && probe.nodeType === Node.ELEMENT_NODE) {
        const kids = probe.childNodes;
        probe = kids[Math.min(range.startOffset, Math.max(0, kids.length - 1))] ?? probe;
      }
      const probeEl = probe instanceof HTMLElement ? probe : probe?.parentElement ?? null;
      if (probeEl && el.contains(probeEl)) {
        const cs = window.getComputedStyle(probeEl);
        const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        if (fam) fontName = fam;
        const px = parseFloat(cs.fontSize);
        if (px) fontSize = Math.round((px * 72) / 96); // px → pt
      }

      const q = (cmd: string) => { try { return document.queryCommandState(cmd); } catch { return false; } };
      setTb({
        bold: q('bold'),
        italic: q('italic'),
        underline: q('underline'),
        strike: q('strikeThrough'),
        bulletList: q('insertUnorderedList'),
        numberedList: q('insertOrderedList'),
        alignCenter: q('justifyCenter'),
        alignRight: q('justifyRight'),
        block,
        fontName,
        fontSize,
      });
    }, []);

    refreshToolbarRef.current = refreshToolbar;

    // Recompute on every selection move while editing.
    useEffect(() => {
      if (!editable) return;
      const handler = () => refreshToolbar();
      document.addEventListener('selectionchange', handler);
      return () => document.removeEventListener('selectionchange', handler);
    }, [editable, refreshToolbar]);

    return (
      <div className={cn('flex flex-col h-full', className)}>
        {/* Toolbar — formatting controls on the left, the File/Edit/View…
            menu bar (and any host extras) pushed to the right, one bar. */}
        <div className="flex items-center gap-0.5 flex-wrap border-b px-3 py-1.5 bg-background">
          {editable ? (
            <>
              <ToolbarButton label={t('sweep.entities.docToolbarUndo')} onClick={() => exec('undo')}><Undo2 className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docToolbarRedo')} onClick={() => exec('redo')}><Redo2 className="h-4 w-4" /></ToolbarButton>
              <ToolbarDivider />
              <BlockTypeMenu current={tb.block} onPick={applyBlock} />
              <ToolbarDivider />
              <FontFamilyMenu current={tb.fontName} onPick={applyFontName} />
              <FontSizeMenu current={tb.fontSize} onPick={applyFontSize} />
              <ToolbarDivider />
              <ToolbarButton label={t('sweep.entities.docToolbarBold')} active={tb.bold} onClick={() => exec('bold')}><Bold className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docToolbarItalic')} active={tb.italic} onClick={() => exec('italic')}><Italic className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docToolbarUnderline')} active={tb.underline} onClick={() => exec('underline')}><Underline className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docMenuStrikethrough')} active={tb.strike} onClick={() => exec('strikeThrough')}><Strikethrough className="h-4 w-4" /></ToolbarButton>
              <ToolbarDivider />
              <ColorMenu
                label={t('sweep.entities.docToolbarTextColor')}
                Icon={Baseline}
                colors={TEXT_COLORS}
                onPick={(c) => applyColor('foreColor', c)}
                onClear={() => applyColor('foreColor', '#000000')}
                clearLabel={t('sweep.entities.docToolbarAutomatic')}
              />
              <ColorMenu
                label={t('sweep.entities.docToolbarHighlightColor')}
                Icon={Highlighter}
                colors={HIGHLIGHT_COLORS}
                onPick={(c) => applyColor('hiliteColor', c)}
                onClear={() => applyColor('hiliteColor', 'transparent')}
                clearLabel={t('sweep.entities.docToolbarNoHighlight')}
              />
              <ToolbarDivider />
              <ToolbarButton label={t('sweep.entities.docMenuLeft')} active={!tb.alignCenter && !tb.alignRight} onClick={() => exec('justifyLeft')}><AlignLeft className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docMenuCenter')} active={tb.alignCenter} onClick={() => exec('justifyCenter')}><AlignCenter className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docMenuRight')} active={tb.alignRight} onClick={() => exec('justifyRight')}><AlignRight className="h-4 w-4" /></ToolbarButton>
              <LineSpacingMenu
                onLineHeight={setLineHeight}
                onToggleSpaceBefore={() => toggleBlockSpacing('top')}
                onToggleSpaceAfter={() => toggleBlockSpacing('bottom')}
              />
              <ToolbarDivider />
              <ToolbarButton label={t('sweep.entities.docToolbarBulletList')} active={tb.bulletList} onClick={() => exec('insertUnorderedList')}><List className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docToolbarNumberedList')} active={tb.numberedList} onClick={() => exec('insertOrderedList')}><ListOrdered className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docToolbarChecklist')} onClick={toggleChecklist}><ListChecks className="h-4 w-4" /></ToolbarButton>
              <ToolbarDivider />
              <ToolbarButton label={t('sweep.entities.docMenuDecreaseIndent')} onClick={() => indentBlock('outdent')}><IndentDecrease className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docMenuIncreaseIndent')} onClick={() => indentBlock('indent')}><IndentIncrease className="h-4 w-4" /></ToolbarButton>
              <ToolbarDivider />
              <ToolbarButton label={t('sweep.entities.docToolbarInsertLink')} onClick={() => cmd.insertLink()}><Link2 className="h-4 w-4" /></ToolbarButton>
              <ToolbarButton label={t('sweep.entities.docMenuClearFormatting')} onClick={() => exec('removeFormat')}><RemoveFormatting className="h-4 w-4" /></ToolbarButton>
            </>
          ) : null}

          {/* Right side: File / Edit / View / Insert / Format / Help + host extras. */}
          <div className="ml-auto flex items-center gap-3">
            <PaginatedDocMenubar cmd={cmd} actions={actions} editable={editable} />
            {toolbarExtra}
          </div>
        </div>

        {/* Pages */}
        <style>{`
          .pgn-doc-editor { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #000; outline: none; }
          :is(.dark) .pgn-doc-editor { color: var(--foreground); }
          .pgn-doc-editor > * { margin: 0; }
          .pgn-doc-editor > * + * { margin-top: 8pt; }
          .pgn-doc-editor h1 { font-size: 20pt; font-weight: 600; }
          .pgn-doc-editor h2 { font-size: 16pt; font-weight: 600; }
          .pgn-doc-editor h3 { font-size: 14pt; font-weight: 600; }
          .pgn-doc-editor ul, .pgn-doc-editor ol { padding-left: 24px; }
          .pgn-doc-editor blockquote { border-left: 3px solid #d0d5dd; padding-left: 12px; color: #475467; }
          :is(.dark) .pgn-doc-editor blockquote { border-left-color: var(--border); color: var(--muted-foreground); }
          .pgn-doc-editor a { color: #2563eb; text-decoration: underline; }
          .pgn-doc-editor ul.pgn-checklist { list-style: none; padding-left: 4px; }
          .pgn-doc-editor ul.pgn-checklist li { position: relative; padding-left: 26px; list-style: none; }
          .pgn-doc-editor ul.pgn-checklist li::before {
            content: ''; position: absolute; left: 0; top: 0.2em;
            width: 15px; height: 15px; border: 1.5px solid #9aa0a6; border-radius: 5px;
            background: #fff; cursor: pointer; box-sizing: border-box;
          }
          .pgn-doc-editor ul.pgn-checklist li[data-checked]::before { background: #2563eb; border-color: #2563eb; }
          .pgn-doc-editor ul.pgn-checklist li[data-checked]::after {
            content: ''; position: absolute; left: 0; top: 0.2em;
            width: 15px; height: 15px; box-sizing: border-box; background-color: #fff;
            -webkit-mask: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='white'%20stroke-width='3'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'/%3E%3C/svg%3E") center / 11px 11px no-repeat;
            mask: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='white'%20stroke-width='3'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M20%206%209%2017l-5-5'/%3E%3C/svg%3E") center / 11px 11px no-repeat;
          }
          .pgn-doc-editor ul.pgn-checklist li[data-checked] { color: #9aa0a6; text-decoration: line-through; }
          :is(.dark) .pgn-doc-editor ul.pgn-checklist li::before { border-color: var(--muted-foreground); background: transparent; }
          @media print {
            @page { size: A4; margin: 25.4mm; }
            .pgn-scroll { background: none !important; overflow: visible !important; height: auto !important; }
            .pgn-page-bg { display: none !important; }
            .pgn-content { padding: 0 !important; }
            .pgn-content [data-pgn-pushed="1"] { margin-top: 0 !important; page-break-before: always; break-before: page; }
          }
        `}</style>

        <div className="pgn-scroll flex-1 overflow-y-auto bg-muted/40 dark:bg-background px-4 pt-5 pb-8">
          <div
            className="relative mx-auto"
            style={{
              width: `${PAGE_WIDTH_PX}px`,
              minHeight: `${pageCount * PAGE_STRIDE_PX - PAGE_GAP_PX}px`,
            }}
          >
            {Array.from({ length: pageCount }).map((_, i) => (
              <div
                key={i}
                aria-hidden
                className="pgn-page-bg absolute left-0 right-0 bg-white border border-gray-200 dark:bg-[#26282c] dark:border-[#383e47] shadow-[0_1px_3px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4)]"
                style={{ top: `${i * PAGE_STRIDE_PX}px`, height: `${PAGE_HEIGHT_PX}px` }}
              />
            ))}

            <div
              ref={editorRef}
              className="pgn-content pgn-doc-editor relative"
              contentEditable={editable}
              suppressContentEditableWarning
              onInput={handleInput}
              onBlur={saveSelection}
              onClick={handleEditorClick}
              style={{
                paddingLeft: `${PAGE_PADDING_PX}px`,
                paddingRight: `${PAGE_PADDING_PX}px`,
                paddingTop: `${PAGE_PADDING_PX}px`,
                paddingBottom: `${PAGE_PADDING_PX}px`,
              }}
            />
          </div>
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Toolbar state — what the format buttons / block-type dropdown reflect about
// the current selection.
// ---------------------------------------------------------------------------

type BlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'quote';

interface ToolbarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  bulletList: boolean;
  numberedList: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  block: BlockKind;
  fontName: string;
  fontSize: number;
}

const INITIAL_TOOLBAR_STATE: ToolbarState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  bulletList: false,
  numberedList: false,
  alignCenter: false,
  alignRight: false,
  block: 'paragraph',
  fontName: 'Arial',
  fontSize: 11,
};

function ToolbarDivider() {
  return <div className="w-px h-5 bg-border mx-1" />;
}

function ToolbarButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title={label}
      // Keep the caret/selection in the document when clicking a toolbar button.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'h-7 w-7 flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors',
        active && 'bg-accent text-foreground',
      )}
    >
      {children}
    </Button>
  );
}

// Curated swatches for the text-color / highlight pickers.
const TEXT_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff',
  '#9900ff', '#ff00ff', '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#cfe2f3',
];

const HIGHLIGHT_COLORS = [
  '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff9900', '#ff0000', '#4a86e8', '#b7b7b7',
  '#fff2cc', '#d9ead3', '#d0e0e3', '#fce5cd', '#f4cccc', '#ead1dc', '#cfe2f3', '#ffffff',
];

function ColorMenu({
  label,
  Icon,
  colors,
  onPick,
  onClear,
  clearLabel,
}: {
  label: string;
  Icon: typeof Pilcrow;
  colors: string[];
  onPick: (color: string) => void;
  onClear: () => void;
  clearLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          title={label}
          onMouseDown={(e) => e.preventDefault()}
          className="h-7 w-7 flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground transition-colors"
        >
          <Icon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="grid grid-cols-8 gap-1">
          {colors.map((c) => (
            <Button
              variant="ghost"
              key={c}
              type="button"
              title={c}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(c); setOpen(false); }}
              className="h-5 w-5 rounded-[4px] border border-border/60 hover:ring-2 hover:ring-ring/50 transition-shadow"
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onClear(); setOpen(false); }}
          className="mt-2 w-full px-2 py-1 text-xs rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {clearLabel}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Font family / size + line-spacing menus
// ---------------------------------------------------------------------------

const FONT_FAMILIES = [
  'Arial',
  'Calibri',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Comic Sans MS',
];

const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72];

function FontFamilyMenu({ current, onPick }: { current: string; onPick: (family: string) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          className="h-[30px] px-2 flex items-center gap-1 text-sm rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title={t('sweep.entities.docToolbarFont')}
        >
          <span className="truncate max-w-[96px] text-left">{current}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-52 p-1 max-h-80 overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {FONT_FAMILIES.map((family) => (
          <Button
            variant="ghost"
            key={family}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onPick(family); setOpen(false); }}
            style={{ fontFamily: family }}
            className={cn(
              'w-full flex items-center px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent text-left',
              family === current && 'bg-accent text-foreground font-medium',
            )}
          >
            {family}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function FontSizeMenu({ current, onPick }: { current: number; onPick: (pt: number) => void }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          className="h-[30px] px-2 flex items-center gap-1 text-sm rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title={t('sweep.entities.docToolbarFontSize')}
        >
          <span className="min-w-[18px] text-center tabular-nums">{current}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-20 p-1 max-h-80 overflow-y-auto"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {FONT_SIZES.map((size) => (
          <Button
            variant="ghost"
            key={size}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onPick(size); setOpen(false); }}
            className={cn(
              'w-full px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent text-left tabular-nums',
              size === current && 'bg-accent text-foreground font-medium',
            )}
          >
            {size}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function LineSpacingMenu({
  onLineHeight,
  onToggleSpaceBefore,
  onToggleSpaceAfter,
}: {
  onLineHeight: (lh: string) => void;
  onToggleSpaceBefore: () => void;
  onToggleSpaceAfter: () => void;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const heights: [string, string][] = [
    [t('sweep.entities.docToolbarSingleSpacing'), '1'],
    ['1.15', '1.15'],
    ['1.5', '1.5'],
    [t('sweep.entities.docToolbarDoubleSpacing'), '2'],
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          title={t('sweep.entities.docToolbarLineAndParagraphSpacing')}
          onMouseDown={(e) => e.preventDefault()}
          className="h-7 w-7 flex items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground transition-colors"
        >
          <AlignVerticalSpaceAround className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {heights.map(([label, value]) => (
          <Button
            variant="ghost"
            key={value}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onLineHeight(value); setOpen(false); }}
            className="w-full px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent text-left"
          >
            {label}
          </Button>
        ))}
        <div className="my-1 h-px bg-border" />
        <Button
          variant="ghost"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onToggleSpaceBefore(); setOpen(false); }}
          className="w-full px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent text-left"
        >
          {t('sweep.entities.docToolbarAddRemoveSpaceBefore')}
        </Button>
        <Button
          variant="ghost"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onToggleSpaceAfter(); setOpen(false); }}
          className="w-full px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent text-left"
        >
          {t('sweep.entities.docToolbarAddRemoveSpaceAfter')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function getBlockItems(
  t: (path: string) => string,
): { kind: BlockKind | null; label: string; Icon: typeof Pilcrow }[] {
  return [
    { kind: 'paragraph', label: t('sweep.entities.docToolbarParagraph'), Icon: Pilcrow },
    { kind: 'heading1', label: t('sweep.entities.docMenuHeading1'), Icon: Heading1 },
    { kind: 'heading2', label: t('sweep.entities.docMenuHeading2'), Icon: Heading2 },
    { kind: 'heading3', label: t('sweep.entities.docMenuHeading3'), Icon: Heading3 },
    { kind: null, label: '__separator__', Icon: Pilcrow },
    { kind: 'bulletList', label: t('sweep.entities.docToolbarBulletList'), Icon: List },
    { kind: 'numberedList', label: t('sweep.entities.docToolbarNumberedList'), Icon: ListOrdered },
    { kind: 'quote', label: t('sweep.entities.docMenuQuote'), Icon: Quote },
  ];
}

function getBlockLabels(t: (path: string) => string): Record<BlockKind, string> {
  return {
    paragraph: t('sweep.entities.docToolbarParagraph'),
    heading1: t('sweep.entities.docMenuHeading1'),
    heading2: t('sweep.entities.docMenuHeading2'),
    heading3: t('sweep.entities.docMenuHeading3'),
    bulletList: t('sweep.entities.docToolbarBulletList'),
    numberedList: t('sweep.entities.docToolbarNumberedList'),
    quote: t('sweep.entities.docMenuQuote'),
  };
}

function BlockTypeMenu({ current, onPick }: { current: BlockKind; onPick: (kind: BlockKind) => void }) {
  const t = useTranslations();
  const blockItems = useMemo(() => getBlockItems(t), [t]);
  const blockLabels = useMemo(() => getBlockLabels(t), [t]);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          className="h-[30px] px-2 flex items-center gap-1 text-sm rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title={t('sweep.entities.docToolbarBlockType')}
        >
          <span className="truncate max-w-[110px]">{blockLabels[current]}</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-48 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {blockItems.map((item, idx) => {
          if (item.label === '__separator__') {
            return <div key={idx} className="my-1 h-px bg-border" />;
          }
          const { kind, label, Icon } = item;
          const match = kind === current;
          return (
            <Button
              variant="ghost"
              key={label}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { if (kind) onPick(kind); setOpen(false); }}
              className={cn(
                'w-full flex items-center px-2 py-1.5 text-sm rounded-[7px] hover:bg-accent',
                match && 'bg-accent text-foreground font-medium',
              )}
            >
              <Icon className="h-4 w-4 mr-2" />
              <span>{label}</span>
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
