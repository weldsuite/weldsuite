import {
  BODY,
  CanvasMeasurer,
  DocLayout,
  DocModel,
  FINAL_SECTION,
  LINE_BREAK,
  OBJECT,
  PARA,
  allHave,
  applyOp,
  caretAt,
  caretRect,
  clearFormatting,
  commonParagraphStyle,
  deleteBackward,
  deleteForward,
  deleteSelection,
  findAll,
  footnoteStoryId,
  formatParagraphs,
  formatText,
  headerSection,
  headerStoryId,
  hitTest,
  indent,
  insertFragment,
  insertLineBreak,
  insertObject,
  insertText,
  isCollapsed,
  isNoop,
  lineBounds,
  linkAt,
  newId,
  nextGrapheme,
  nextWord,
  normalize,
  paragraphAt,
  removeLink,
  replaceAll,
  replaceRange,
  resolvedParagraphAt,
  resolvedStyleAt,
  selectionRange,
  selectionRects,
  setLink,
  splitParagraph,
  textStats,
  toggleChecked,
  toggleList,
  transform,
  wordAt,
  type Affinity,
  type DocSelection,
  type DocSnapshot,
  type DocumentStats,
  type Edit,
  type FindOptions,
  type Fragment,
  type HeaderKind,
  type ListKind,
  type Match,
  type Op,
  type PageLayout,
  type ParaPatch,
  type ParaProps,
  type SectionProps,
  type TextStyle,
  type TextMeasurer,
  type TextStylePatch,
} from '@weldsuite/docs-engine';
import { copyFragment, readClipboard, type ClipboardPayload } from './clipboard';

const UNDO_LIMIT = 300;
/** Typing within this long of the last keystroke joins its undo step. */
const TYPING_GROUP_MS = 1500;

export type Movement = 'char' | 'word' | 'line' | 'lineEdge' | 'paragraph' | 'page' | 'document';

export interface ControllerOptions {
  /** Applies an op to the document (the collaboration client in a co-edited document); default: locally. */
  applyOp?: (op: Op) => Op;
  /** Called after every local change (autosave, sending). */
  onOp?: (op: Op) => void;
  /** Document title, for `title` fields and printing. */
  title?: string;
  locale?: string;
  /** Text measurement (tests pass the built-in metrics); default: a canvas. */
  measurer?: TextMeasurer;
}

interface UndoEntry {
  op: Op;
  inverse: Op;
  before: DocSelection;
  after: DocSelection;
  typing: boolean;
  at: number;
}

export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

/**
 * Everything the editor does to a document goes through here: it owns the
 * model, its layout, the selection and the undo stacks, and notifies React
 * through `subscribe` (useSyncExternalStore).
 */
export class DocController {
  doc: DocModel;
  layout: DocLayout;
  pages: PageLayout[] = [];
  selection: DocSelection = caretAt(BODY, 0);
  /** Which line a caret at a soft wrap belongs to. */
  affinity: Affinity = 'forward';
  /** Formatting toggled with a caret (Ctrl+B with nothing selected): applies to what is typed next. */
  pending: TextStyle | null = null;
  readOnly = false;
  zoom = 1;
  showRuler = true;
  showOutline = false;
  /** Bumped on every change; the React snapshot. */
  version = 0;
  /** Bumped when the content changed (not just the selection). */
  contentVersion = 0;
  find: { query: string; options: FindOptions; matches: Match[]; index: number } | null = null;
  dialog: 'pageSetup' | 'wordCount' | 'link' | 'shortcuts' | null = null;
  printing = false;

  /** x the caret aims for when moving up and down through lines of different lengths. */
  private goalX: number | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    source: DocSnapshot | DocModel | null,
    readonly options: ControllerOptions = {},
  ) {
    this.doc = source instanceof DocModel ? source : source ? DocModel.fromSnapshot(source) : DocModel.create();
    this.layout = new DocLayout(this.doc, { measurer: options.measurer ?? browserMeasurer() });
    this.pages = this.layout.update();
  }

  // ---------------------------------------------------------------- React plumbing

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  snapshot(): DocSnapshot {
    return this.doc.toSnapshot();
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    this.emit();
  }

  /** Web fonts finished loading: measure everything again. */
  fontsChanged(): void {
    this.layout.invalidateAll();
    this.relayout();
  }

  // ---------------------------------------------------------------- applying

  /** Applies an edit (or op) made here, recording it for undo. */
  apply(edit: Edit | Op, options: { typing?: boolean; keepPending?: boolean } = {}): void {
    if (this.readOnly) return;
    const op = normalize('op' in edit ? edit.op : edit);
    const before = this.selection;
    const after = 'op' in edit ? edit.selection : this.selection;
    if (!isNoop(op)) {
      const inverse = this.run(op);
      const last = this.undoStack[this.undoStack.length - 1];
      const now = Date.now();
      if (options.typing && last?.typing && now - last.at < TYPING_GROUP_MS && sameStory(last.after, before) && last.after.head === before.head) {
        // One undo step for a run of typing.
        last.op = normalize({ type: 'batch', ops: [last.op, op] });
        last.inverse = normalize({ type: 'batch', ops: [inverse, last.inverse] });
        last.after = after;
        last.at = now;
      } else {
        this.undoStack.push({ op, inverse, before, after, typing: !!options.typing, at: now });
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      }
      this.redoStack = [];
      this.options.onOp?.(op);
    }
    if (!options.keepPending) this.pending = null;
    this.setSelectionQuietly(after);
    this.relayout();
  }

  private run(op: Op): Op {
    if (this.options.applyOp) {
      const inverse = this.options.applyOp(op);
      this.layout.applied(op);
      return inverse;
    }
    return this.layout.apply(op);
  }

  // Each stack entry holds, as `inverse`, the op that steps back (undo) or forward (redo).
  undo(): void {
    if (this.readOnly) return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    const inverse = this.run(entry.inverse);
    this.redoStack.push({ ...entry, op: entry.inverse, inverse });
    this.options.onOp?.(entry.inverse);
    this.setSelectionQuietly(this.clampSelection(entry.before));
    this.relayout();
  }

  redo(): void {
    if (this.readOnly) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    const inverse = this.run(entry.inverse);
    this.undoStack.push({ ...entry, op: entry.inverse, inverse, typing: false });
    this.options.onOp?.(entry.inverse);
    this.setSelectionQuietly(this.clampSelection(entry.after));
    this.relayout();
  }

  /**
   * Someone else's op was applied under this user's unconfirmed edits: move
   * undo entries past it, newest first, and keep the selection where it was.
   */
  remoteOp(op: Op): void {
    for (const stack of [this.undoStack, this.redoStack]) {
      let against = op;
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i]!;
        const inverse = transform(entry.inverse, against, true);
        against = transform(against, entry.inverse, false);
        entry.inverse = inverse;
      }
    }
    this.selection = this.clampSelection(mapSelection(this.selection, op));
    this.layout.stale();
    this.relayout();
  }

  /** The document was replaced (a fresh copy from the room). Undo history no longer applies. */
  replaceDocument(doc: DocModel): void {
    this.doc = doc;
    this.layout = new DocLayout(doc, { measurer: this.options.measurer ?? browserMeasurer() });
    this.undoStack = [];
    this.redoStack = [];
    this.selection = this.clampSelection(this.selection);
    this.relayout();
  }

  /** Lays out what changed and tells React. */
  relayout(): void {
    this.pages = this.layout.update();
    this.contentVersion++;
    if (this.find) this.refreshFind();
    this.emit();
  }

  // ---------------------------------------------------------------- selection

  setSelection(sel: DocSelection, affinity: Affinity = 'forward'): void {
    this.setSelectionQuietly(this.clampSelection(sel));
    this.affinity = affinity;
    this.goalX = null;
    this.pending = null;
    this.emit();
  }

  private setSelectionQuietly(sel: DocSelection): void {
    this.selection = sel;
  }

  private clampSelection(sel: DocSelection): DocSelection {
    const story = this.doc.stories.get(sel.story);
    if (!story) return caretAt(BODY, 0);
    const max = story.length - 1;
    return { story: sel.story, anchor: Math.max(0, Math.min(sel.anchor, max)), head: Math.max(0, Math.min(sel.head, max)) };
  }

  selectAll(): void {
    const story = this.doc.stories.get(this.selection.story)!;
    this.setSelection({ story: this.selection.story, anchor: 0, head: story.length - 1 });
  }

  /** Moves the caret (or extends the selection) by a unit in a direction. */
  move(dir: 1 | -1, unit: Movement, extend: boolean): void {
    const sel = this.selection;
    const story = this.doc.stories.get(sel.story)!;
    const max = story.length - 1;
    const { from, to } = selectionRange(sel);
    let head = sel.head;
    let affinity: Affinity = 'forward';
    let keepGoal = false;
    if (!extend && !isCollapsed(sel) && (unit === 'char' || unit === 'word')) {
      head = dir < 0 ? from : to;
    } else {
      switch (unit) {
        case 'char':
          head = nextGrapheme(story, head, dir);
          break;
        case 'word':
          head = nextWord(story, head, dir);
          break;
        case 'lineEdge': {
          const bounds = lineBounds(this.layout, sel.story, head, this.affinity);
          if (bounds) {
            head = dir < 0 ? bounds.start : bounds.end;
            // The end of a soft-wrapped line is drawn on that line.
            if (dir > 0 && bounds.end > bounds.start && story.charAt(bounds.end) !== PARA) affinity = 'backward';
          }
          break;
        }
        case 'line':
        case 'page': {
          const next = this.vertical(dir, unit === 'page');
          if (next) {
            head = next.pos;
            affinity = next.affinity;
          }
          keepGoal = true;
          break;
        }
        case 'paragraph': {
          const p = paragraphAt(story, head);
          head = dir < 0 ? (head > p.start ? p.start : paragraphAt(story, Math.max(0, p.start - 1)).start) : p.end < max ? p.end + 1 : p.end;
          break;
        }
        case 'document':
          head = dir < 0 ? 0 : max;
          break;
      }
    }
    head = Math.max(0, Math.min(head, max));
    const goal = this.goalX;
    this.setSelection(extend ? { story: sel.story, anchor: sel.anchor, head } : caretAt(sel.story, head), affinity);
    if (keepGoal) this.goalX = goal ?? this.goalX;
  }

  /** The position a line (or a page) above or below the caret, at the same x. */
  private vertical(dir: 1 | -1, byPage: boolean): { pos: number; affinity: Affinity } | null {
    const sel = this.selection;
    const rect = caretRect(this.layout, sel.story, sel.head, { affinity: this.affinity });
    if (!rect) return null;
    this.goalX ??= rect.x;
    const x = this.goalX;
    const page = this.pages[rect.page]!;
    const step = byPage ? page.height * 0.85 : 0;
    let pageIndex = rect.page;
    let y = dir > 0 ? rect.y + rect.height + 1 + step : rect.y - 1 - step;
    for (let tries = 0; tries < 3; tries++) {
      const hit = hitTest(this.layout, pageIndex, x, y);
      if (hit && hit.story === sel.story && hit.pos !== sel.head) return { pos: hit.pos, affinity: hit.affinity };
      // Past this page's content: continue on the next (or previous) page.
      pageIndex += dir;
      const next = this.pages[pageIndex];
      if (!next) break;
      const col = next.columns[0]!;
      y = dir > 0 ? col.y + 1 : col.y + col.height - 1;
    }
    return null;
  }

  /** A click on a page: places the caret (or extends with Shift); a double click selects a word, a triple click the paragraph. */
  clickAt(page: number, x: number, y: number, options: { extend?: boolean; detail?: number } = {}): void {
    const hit = hitTest(this.layout, page, x, y);
    if (!hit) return;
    const story = this.doc.stories.get(hit.story);
    if (!story) return;
    // A tick box in a checklist.
    if (!options.extend && (options.detail ?? 1) === 1 && this.toggleCheckboxAt(page, x, y, hit.story, hit.pos)) return;
    if (options.extend && hit.story === this.selection.story) {
      this.setSelection({ story: hit.story, anchor: this.selection.anchor, head: hit.pos }, hit.affinity);
      return;
    }
    if (options.detail === 2) {
      const w = wordAt(story, hit.pos);
      this.setSelection({ story: hit.story, anchor: w.from, head: w.to });
      return;
    }
    if (options.detail && options.detail >= 3) {
      const p = paragraphAt(story, hit.pos);
      this.setSelection({ story: hit.story, anchor: p.start, head: p.end });
      return;
    }
    this.setSelection(caretAt(hit.story, hit.pos), hit.affinity);
  }

  /** Dragging with the button down extends the selection (within the story it started in). */
  dragTo(page: number, x: number, y: number): void {
    const hit = hitTest(this.layout, page, x, y);
    if (!hit || hit.story !== this.selection.story) return;
    if (hit.pos === this.selection.head) return;
    this.setSelection({ story: hit.story, anchor: this.selection.anchor, head: hit.pos }, hit.affinity);
  }

  private toggleCheckboxAt(page: number, x: number, y: number, story: string, pos: number): boolean {
    const p = paragraphAt(this.doc.stories.get(story)!, pos);
    const props = this.doc.stories.get(story)!.paraAt(p.end);
    if (!props?.list || this.doc.lists.get(props.list.id)?.levels[props.list.level]?.format !== 'check') return false;
    const caret = caretRect(this.layout, story, p.start);
    if (!caret || caret.page !== page) return false;
    // The box sits in the hanging indent, left of the text.
    if (x > caret.x - 2 || x < caret.x - 24 || y < caret.y || y > caret.y + caret.height) return false;
    if (!this.readOnly) this.apply(toggleChecked(this.doc, story, p.end));
    return true;
  }

  /** Puts the caret in the header or footer of the page (creating it). */
  editHeader(kind: HeaderKind, pageIndex = 0): void {
    const page = this.pages[pageIndex] ?? this.pages[0]!;
    const area = kind === 'header' ? page.header : page.footer;
    if (area?.story) {
      this.setSelection(caretAt(area.story, 0));
      return;
    }
    const id = headerStoryId(page.sectionId ?? FINAL_SECTION, kind, 'default');
    if (!this.doc.stories.has(id)) this.apply({ type: 'createStory', story: id }, {});
    this.setSelection(caretAt(id, 0));
  }

  get inHeaderOrFooter(): boolean {
    return headerSection(this.selection.story) !== null;
  }

  // ---------------------------------------------------------------- typing

  type(text: string): void {
    this.apply(insertText(this.doc, this.selection, text, this.pending), { typing: true });
  }

  backspace(word = false): void {
    const edit = deleteBackward(this.doc, this.selection, word ? 'word' : 'char');
    if (isNoop(edit.op)) this.setSelection(edit.selection);
    else this.apply(edit, { typing: isCollapsed(this.selection) });
  }

  deleteForward(word = false): void {
    const edit = deleteForward(this.doc, this.selection, word ? 'word' : 'char');
    if (isNoop(edit.op)) this.setSelection(edit.selection);
    else this.apply(edit);
  }

  enter(): void {
    this.apply(splitParagraph(this.doc, this.selection), { keepPending: true });
  }

  lineBreak(): void {
    this.apply(insertLineBreak(this.doc, this.selection));
  }

  /** Tab: list items change level; elsewhere a tab character is typed (a selection over paragraphs indents them). */
  tab(shift: boolean): void {
    const props = this.paragraph();
    const multi = !isCollapsed(this.selection) && this.doc.stories.get(this.selection.story)!.text(selectionRange(this.selection).from, selectionRange(this.selection).to).includes(PARA);
    const atStart = isCollapsed(this.selection) && paragraphAt(this.doc.stories.get(this.selection.story)!, this.selection.head).start === this.selection.head;
    if (props.list && (atStart || multi || shift)) {
      this.apply(indent(this.doc, this.selection, shift ? -1 : 1));
      return;
    }
    if (shift || multi) {
      this.apply(indent(this.doc, this.selection, shift ? -1 : 1));
      return;
    }
    this.type('\t');
  }

  // ---------------------------------------------------------------- formatting

  /** The resolved formatting at the caret (for the toolbar). */
  textStyle(): TextStyle & { font: string; size: number } {
    return resolvedStyleAt(this.doc, this.selection, this.pending);
  }

  paragraph(): ParaProps {
    return resolvedParagraphAt(this.doc, this.selection);
  }

  paragraphStyle(): string | null {
    return commonParagraphStyle(this.doc, this.selection);
  }

  isActive(key: 'bold' | 'italic' | 'underline' | 'strike' | 'smallCaps' | 'allCaps'): boolean {
    return allHave(this.doc, this.selection, key, this.pending);
  }

  toggle(key: 'bold' | 'italic' | 'underline' | 'strike'): void {
    const on = !this.isActive(key);
    this.setTextStyle({ [key]: on ? true : null });
  }

  toggleScript(script: 'super' | 'sub'): void {
    const current = this.textStyle().script;
    this.setTextStyle({ script: current === script ? null : script });
  }

  /** Character formatting: the selection, or what is typed next at a caret. */
  setTextStyle(patch: TextStylePatch): void {
    if (this.readOnly) return;
    if (isCollapsed(this.selection)) {
      const next: Record<string, unknown> = { ...this.pending };
      for (const [k, v] of Object.entries(patch)) next[k] = v === null ? undefined : v;
      this.pending = next as TextStyle;
      this.emit();
      return;
    }
    this.apply(formatText(this.selection, patch));
  }

  setParagraph(patch: ParaPatch): void {
    this.apply(formatParagraphs(this.doc, this.selection, patch), { keepPending: true });
  }

  setParagraphStyle(style: string): void {
    this.setParagraph({ style: style === 'normal' ? null : style });
  }

  toggleList(kind: ListKind): void {
    this.apply(toggleList(this.doc, this.selection, kind));
  }

  indent(delta: 1 | -1): void {
    this.apply(indent(this.doc, this.selection, delta));
  }

  clearFormatting(): void {
    this.pending = null;
    this.apply(clearFormatting(this.doc, this.selection));
  }

  link(): { url: string; text: string } | null {
    const l = linkAt(this.doc, this.selection.story, this.selection.head);
    if (l) return { url: l.url, text: this.doc.stories.get(this.selection.story)!.text(l.from, l.to) };
    return null;
  }

  setLink(url: string, text?: string): void {
    const existing = linkAt(this.doc, this.selection.story, this.selection.head);
    if (existing && isCollapsed(this.selection)) {
      this.apply({ type: 'formatText', story: this.selection.story, at: existing.from, runs: [[existing.to - existing.from, { link: url }]] });
      return;
    }
    this.apply(setLink(this.doc, this.selection, url, text && isCollapsed(this.selection) ? text : undefined));
  }

  removeLink(): void {
    this.apply(removeLink(this.doc, this.selection.story, this.selection.head));
  }

  insertPageBreak(): void {
    this.apply(insertObject(this.doc, this.selection, { kind: 'pageBreak' }));
  }

  insertHorizontalRule(): void {
    this.apply(insertObject(this.doc, this.selection, { kind: 'hr' }, true));
  }

  insertPageNumber(field: 'page' | 'pages' = 'page'): void {
    this.apply(insertObject(this.doc, this.selection, { kind: 'field', field }));
  }

  insertDate(): void {
    this.apply(insertObject(this.doc, this.selection, { kind: 'field', field: 'date' }));
  }

  /** Adds a footnote at the caret and moves into it. */
  insertFootnote(): void {
    if (this.selection.story !== BODY) return;
    const id = newId();
    const del = deleteSelection(this.doc, this.selection);
    const at = del.selection.head;
    this.apply({
      op: { type: 'batch', ops: [del.op, { type: 'insert', story: BODY, at, content: { text: OBJECT, objects: [[0, { kind: 'footnote', id }]], stories: { [footnoteStoryId(id)]: { text: PARA, runs: [[1, { size: 10 }]] } } } }] },
      selection: caretAt(footnoteStoryId(id), 0),
    });
  }

  // ---------------------------------------------------------------- page setup

  get section(): SectionProps {
    return this.doc.props.section;
  }

  setSection(patch: Partial<SectionProps>): void {
    this.apply({ type: 'setDocProps', patch: { section: { ...this.doc.props.section, ...patch } } }, { keepPending: true });
  }

  setPageless(pageless: boolean): void {
    this.apply({ type: 'setDocProps', patch: { pageless: pageless || null } }, { keepPending: true });
  }

  setZoom(zoom: number): void {
    this.zoom = Math.max(0.25, Math.min(4, zoom));
    this.emit();
  }

  setView(patch: { showRuler?: boolean; showOutline?: boolean }): void {
    Object.assign(this, patch);
    this.emit();
  }

  openDialog(dialog: DocController['dialog']): void {
    this.dialog = dialog;
    this.emit();
  }

  setPrinting(printing: boolean): void {
    this.printing = printing;
    this.emit();
  }

  // ---------------------------------------------------------------- clipboard

  copy(): ClipboardPayload | null {
    if (isCollapsed(this.selection)) return null;
    const { from, to } = selectionRange(this.selection);
    return copyFragment(this.doc, this.selection.story, from, to);
  }

  cut(): ClipboardPayload | null {
    const payload = this.copy();
    if (payload && !this.readOnly) this.apply(deleteSelection(this.doc, this.selection));
    return payload;
  }

  paste(data: { html?: string; text?: string; json?: string }, plain = false): void {
    const fragment: Fragment | null = readClipboard(data, plain);
    if (!fragment) return;
    this.apply(insertFragment(this.doc, this.selection, fragment));
  }

  // ---------------------------------------------------------------- find and replace

  openFind(): void {
    this.find ??= { query: '', options: {}, matches: [], index: 0 };
    if (!isCollapsed(this.selection)) {
      const { from, to } = selectionRange(this.selection);
      const text = this.doc.stories.get(this.selection.story)!.text(from, to);
      if (!text.includes(PARA)) this.find.query = text;
    }
    this.refreshFind();
    this.emit();
  }

  closeFind(): void {
    this.find = null;
    this.emit();
  }

  setFind(query: string, options: FindOptions): void {
    this.find = { query, options, matches: [], index: 0 };
    this.refreshFind();
    this.emit();
  }

  private refreshFind(): void {
    if (!this.find) return;
    this.find.matches = findAll(this.doc, this.find.query, this.find.options);
    const head = this.selection.head;
    const i = this.find.matches.findIndex((m) => m.story === this.selection.story && m.from >= Math.min(head, selectionRange(this.selection).from));
    this.find.index = i < 0 ? 0 : i;
  }

  findStep(dir: 1 | -1): void {
    if (!this.find?.matches.length) return;
    const n = this.find.matches.length;
    const current = this.find.matches[this.find.index]!;
    const onIt = this.selection.story === current.story && selectionRange(this.selection).from === current.from && selectionRange(this.selection).to === current.to;
    if (onIt) this.find.index = (this.find.index + dir + n) % n;
    const m = this.find.matches[this.find.index]!;
    this.setSelection({ story: m.story, anchor: m.from, head: m.to });
  }

  replaceCurrent(replacement: string): void {
    const m = this.find?.matches[this.find.index];
    if (!m) return;
    const op = replaceRange(this.doc, m.story, m.from, m.to, replacement);
    this.apply({ op, selection: caretAt(m.story, m.from + replacement.length) });
    this.findStep(1);
  }

  replaceAll(replacement: string): number {
    if (!this.find) return 0;
    const { op, count } = replaceAll(this.doc, this.find.query, replacement, this.find.options);
    if (count) this.apply(op);
    return count;
  }

  // ---------------------------------------------------------------- information

  stats(selectionOnly = false): DocumentStats {
    if (selectionOnly && !isCollapsed(this.selection)) {
      const { from, to } = selectionRange(this.selection);
      return textStats(this.doc.stories.get(this.selection.story)!.text(from, to));
    }
    return textStats(this.doc.body.text());
  }

  /** Headings in the body, for the outline. */
  outline(): OutlineItem[] {
    const out: OutlineItem[] = [];
    const body = this.doc.body;
    body.forEachAttr(0, body.length, (pos, attr) => {
      if (body.charAt(pos) !== PARA) return;
      const style = (attr as ParaProps).style;
      const level = style ? this.doc.styles.get(style)?.outline : undefined;
      if (level === undefined) return;
      const start = body.lastIndexOf(PARA, pos - 1) + 1;
      const text = body.text(start, pos).replace(LINE_BREAK_OR_OBJECT, ' ').trim();
      if (text) out.push({ level, text, pos: start });
    });
    return out;
  }

  /** Page the caret is on (0-based). */
  caretPage(): number {
    return caretRect(this.layout, this.selection.story, this.selection.head, { affinity: this.affinity })?.page ?? 0;
  }

  selectionRects() {
    const { from, to } = selectionRange(this.selection);
    return selectionRects(this.layout, this.selection.story, from, to);
  }

  caret() {
    return caretRect(this.layout, this.selection.story, this.selection.head, { affinity: this.affinity });
  }

  /** Applies an op without undo (tests, imports). */
  applyRaw(op: Op): void {
    applyOp(this.doc, op);
    this.layout.stale();
    this.relayout();
  }
}

const LINE_BREAK_OR_OBJECT = new RegExp(`[${LINE_BREAK}${OBJECT}]`, 'g');

function sameStory(a: DocSelection, b: DocSelection): boolean {
  return a.story === b.story;
}

/** Where a selection goes when an op someone else made is applied. */
function mapSelection(sel: DocSelection, op: Op): DocSelection {
  const t = transform({ type: 'patchAnchors', set: [{ id: 'sel', kind: 'bookmark', story: sel.story, from: Math.min(sel.anchor, sel.head), to: Math.max(sel.anchor, sel.head) }] }, op, false);
  const anchor = t.type === 'patchAnchors' ? t.set?.[0] : undefined;
  if (!anchor) return sel;
  const forward = sel.anchor <= sel.head;
  return { story: sel.story, anchor: forward ? anchor.from : anchor.to, head: forward ? anchor.to : anchor.from };
}

/** A canvas measurer (the layout puts its own width cache in front). */
function browserMeasurer(): CanvasMeasurer {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const ctx = canvas.getContext('2d') as unknown as ConstructorParameters<typeof CanvasMeasurer>[0];
  return new CanvasMeasurer(ctx);
}
