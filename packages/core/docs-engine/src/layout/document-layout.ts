/**
 * Lays a whole document out into pages, and answers the geometry questions
 * an editor asks: where is the caret, what is under the pointer, which
 * rectangles does a selection cover.
 *
 * Layout is incremental. Each story keeps its paragraphs' layouts
 * (`StoryFlow`); an op tells the layout which paragraphs it touched
 * (`applied`), and only those are broken into lines again. Anything else a
 * paragraph's look depends on (its list number, footnote numbers, the
 * tables in it, named styles) is part of its cache key, so a change there
 * re-lays it too. Pagination then runs over the cached lines, which is cheap.
 */

import { OBJECT } from '../model/chars';
import type { DocModel } from '../model/document';
import { ListCounter, formatNumber } from '../model/numbering';
import {
  BODY,
  FINAL_SECTION,
  cellStoryId,
  footnoteStoryId,
  headerSection,
  headerStoryId,
  type HeaderKind,
  type HeaderVariant,
  type ObjectData,
  type SectionProps,
} from '../model/objects';
import type { ParaProps } from '../model/styles';
import { stableKey } from '../model/styles';
import type { Op } from '../ops/types';
import { applyOp } from '../ops/apply';
import { batch, runsLength, unbatch } from '../ops/types';
import { contentKey, StoryFlow } from './flow';
import { CachedMeasurer, type TextMeasurer } from './measure';
import { layoutParagraph, type Marker, type ParagraphContext } from './paragraph';
import { RunStyles } from './run-style';
import { layoutTable, type StoryBlockLayout } from './table';
import type { PageArea, PageLayout, ParaEntry, ParagraphLayout, PlacedItem } from './types';
import { paginate } from './paginate';

export interface DocLayoutOptions {
  measurer: TextMeasurer;
}

export class DocLayout {
  pages: PageLayout[] = [];
  readonly measurer: CachedMeasurer;
  readonly styles: RunStyles;
  private readonly flows = new Map<string, StoryFlow>();
  private stylesVersion = 0;
  private readonly paragraphContext: ParagraphContext;
  private readonly markers = new WeakMap<ParaEntry, Marker | null>();
  private readonly extraKeys = new WeakMap<ParaEntry, string>();
  private readonly footnoteNumbers = new Map<string, number>();
  /** Footnote ids in reference order. */
  footnoteOrder: string[] = [];
  /** Where each paragraph entry was placed in the last pagination. */
  readonly placements = new Map<ParaEntry, { page: number; area: PageArea; item: PlacedItem }[]>();
  /** The entry (and its story) holding each table, from the last numbering pass. */
  readonly tableOwners = new Map<string, { story: string; entry: ParaEntry }>();
  /** For cell and footnote stories: the story and entry holding them. */
  readonly storyOwners = new Map<string, { story: string; entry: ParaEntry; table?: string }>();

  constructor(
    readonly doc: DocModel,
    options: DocLayoutOptions,
  ) {
    this.measurer = new CachedMeasurer(options.measurer);
    this.styles = new RunStyles(doc);
    this.paragraphContext = {
      doc,
      measurer: this.measurer,
      styles: this.styles,
      tabInterval: 36,
      footnoteNumber: (id) => this.footnoteNumber(id),
      layoutTable: (tableId, width) => layoutTable(this.doc, tableId, width, this),
    };
  }

  /**
   * Some story changed without `applied` being told (a remote edit applied
   * under unconfirmed local ones): re-scan every story on the next update,
   * reusing the layout of unchanged paragraphs.
   */
  stale(): void {
    for (const flow of this.flows.values()) flow.version = -1;
  }

  // ---------------------------------------------------------------- invalidation

  /**
   * Tell the layout an op was just applied to the document. Call it after
   * each op (or use `apply`, which does both op by op); a story the layout
   * was not current with before the op is re-scanned on the next update.
   */
  applied(op: Op): void {
    switch (op.type) {
      case 'batch':
        for (const o of op.ops) this.applied(o);
        return;
      case 'insert':
      case 'delete':
      case 'formatText':
      case 'formatParagraphs':
      case 'setObject': {
        const flow = this.flows.get(op.story);
        const story = this.doc.stories.get(op.story);
        // Only when the flow matched the story right before this op; otherwise it rebuilds.
        if (!flow || !story || flow.version !== story.versionBefore) return;
        if (op.type === 'insert') flow.inserted(story, op.at, op.content.text.length);
        else if (op.type === 'delete') flow.deleted(story, op.from, op.to);
        else flow.dirty(story, op.at, op.type === 'setObject' ? op.at + 1 : op.at + runsLength(op.runs));
        return;
      }
      case 'createStory':
      case 'deleteStory':
        this.flows.delete(op.story);
        return;
      case 'setDocProps':
      case 'patchStyles':
      case 'patchLists':
        this.invalidateAll();
        return;
      default:
        // Table ops change the table's key; anchors do not affect layout.
        return;
    }
  }

  /** Applies an op to the document op by op, telling the layout about each; returns the inverse. */
  apply(op: Op): Op {
    const inverses: Op[] = [];
    for (const o of unbatch(op)) {
      inverses.push(applyOp(this.doc, o));
      this.applied(o);
    }
    return batch(inverses.reverse());
  }

  /** Forget every cached layout (fonts loaded, zoom-independent settings changed). */
  invalidateAll(): void {
    this.measurer.clear();
    this.stylesVersion++;
    this.styles.clear();
  }

  // ---------------------------------------------------------------- layout

  flow(storyId: string): StoryFlow | null {
    const story = this.doc.stories.get(storyId);
    if (!story) return null;
    let flow = this.flows.get(storyId);
    if (!flow) {
      flow = new StoryFlow(storyId);
      this.flows.set(storyId, flow);
    }
    if (flow.version !== story.version) flow.rebuild(story);
    return flow;
  }

  /** Lays the document out again (only what changed) and paginates it. */
  update(): PageLayout[] {
    for (const id of this.flows.keys()) if (!this.doc.stories.has(id)) this.flows.delete(id);
    this.number();
    this.pages = paginate(this);
    return this.pages;
  }

  /** The cached (or fresh) layout of a paragraph at a width. */
  layoutEntry(storyId: string, entry: ParaEntry, width: number): ParagraphLayout {
    const marker = this.markers.get(entry) ?? null;
    const key = `${Math.round(width * 100)}|${marker?.text ?? ''}|${this.stylesVersion}|${this.extraKeys.get(entry) ?? ''}`;
    if (entry.layout && entry.key === key) return entry.layout;
    const story = this.doc.stories.get(storyId)!;
    entry.layout = layoutParagraph(this.paragraphContext, story, entry.start, entry.end, width, marker);
    entry.key = key;
    entry.content = contentKey(story, entry.start, entry.end);
    return entry.layout;
  }

  /** A story laid out as one column with no page breaks (table cells, headers, footers, footnotes). */
  layoutStory(storyId: string, width: number): StoryBlockLayout {
    const flow = this.flow(storyId);
    if (!flow) return { paragraphs: [], height: 0 };
    const paragraphs: StoryBlockLayout['paragraphs'] = [];
    let y = 0;
    flow.entries.forEach((e, i) => {
      const layout = this.layoutEntry(storyId, e, width);
      if (i > 0) y += layout.spaceBefore;
      paragraphs.push({ entry: e, layout, y });
      y += layout.height + (i < flow.entries.length - 1 ? layout.spaceAfter : 0);
    });
    return { paragraphs, height: y };
  }

  footnoteNumber(id: string): number {
    return this.footnoteNumbers.get(id) ?? 0;
  }



  /**
   * Walks the document in reading order: list numbers, footnote numbers,
   * which paragraph holds which table, and the extra cache key of
   * paragraphs whose look depends on other stories (their tables' cells).
   */
  private number(): void {
    this.paragraphContext.tabInterval = this.doc.props.tabInterval ?? 36;
    const counter = new ListCounter((id) => this.doc.lists.get(id));
    this.footnoteNumbers.clear();
    this.footnoteOrder = [];
    this.tableOwners.clear();
    this.storyOwners.clear();
    const visit = (storyId: string): string => {
      const flow = this.flow(storyId);
      const story = this.doc.stories.get(storyId);
      if (!flow || !story) return '';
      let storyKey = `${story.version}`;
      for (const entry of flow.entries) {
        const props = (story.attrAt(entry.end) as ParaProps | undefined) ?? {};
        const next = counter.next(props);
        this.markers.set(entry, next ? { text: next.marker, level: next.level } : null);
        let extra = '';
        story.forEachAttr(entry.start, entry.end, (pos, attr) => {
          if (story.charAt(pos) !== OBJECT) return;
          const obj = attr as ObjectData;
          if (obj.kind === 'footnote') {
            this.footnoteOrder.push(obj.id);
            this.footnoteNumbers.set(obj.id, this.footnoteOrder.length);
            this.storyOwners.set(footnoteStoryId(obj.id), { story: storyId, entry });
            extra += `f${this.footnoteOrder.length}`;
            visit(footnoteStoryId(obj.id));
          } else if (obj.kind === 'table') {
            const table = this.doc.tables.get(obj.id);
            if (!table) return;
            this.tableOwners.set(obj.id, { story: storyId, entry });
            extra += `t${stableKey(table)}`;
            for (const r of table.rows) {
              for (const c of table.cols) {
                const cell = cellStoryId(obj.id, r.id, c.id);
                this.storyOwners.set(cell, { story: storyId, entry, table: obj.id });
                extra += `c${visit(cell)}`;
              }
            }
          }
        });
        this.extraKeys.set(entry, extra);
        storyKey += extra;
      }
      return storyKey;
    };
    visit(BODY);
    // Headers and footers (with any tables in them) are numbered on their own, after the body.
    for (const id of this.doc.stories.keys()) if (headerSection(id)) visit(id);
  }

  // ---------------------------------------------------------------- sections

  /** Sections in order: each section break in the body ends one; the last is the document's. */
  sections(): { id: string; props: SectionProps; start: string; endsAt: number }[] {
    const out: { id: string; props: SectionProps; start: string; endsAt: number }[] = [];
    const body = this.doc.body;
    let startType = 'nextPage';
    body.forEachAttr(0, body.length, (pos, attr) => {
      if (body.charAt(pos) !== OBJECT || (attr as ObjectData).kind !== 'sectionBreak') return;
      const sb = attr as Extract<ObjectData, { kind: 'sectionBreak' }>;
      out.push({ id: sb.id, props: sb.section, start: startType, endsAt: pos });
      startType = sb.start;
    });
    out.push({ id: FINAL_SECTION, props: this.doc.props.section, start: startType, endsAt: body.length });
    return out;
  }

  /** The header or footer story shown for a section, following links to earlier sections. */
  headerStory(sectionIds: string[], index: number, kind: HeaderKind, variant: HeaderVariant): string | null {
    for (let i = index; i >= 0; i--) {
      const id = headerStoryId(sectionIds[i]!, kind, variant);
      if (this.doc.stories.has(id)) return id;
    }
    return null;
  }

  pageLabel(n: number, section: SectionProps): string {
    return formatNumber(n, section.pageNumberFormat ?? 'decimal');
  }
}
