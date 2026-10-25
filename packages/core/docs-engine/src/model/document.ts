/**
 * A document: its stories, tables, named styles, lists, anchors and page
 * setup. Changed only through ops (`applyOp`), so every replica that runs the
 * same ops in the same order holds the same document.
 */

import { OBJECT, PARA } from './chars';
import { contentToPiece, pieceToContent, type Content, type StoryContent } from './content';
import { BUILT_IN_STYLES, bulletList, checkList, numberedList } from './defaults';
import {
  BODY,
  DEFAULT_SECTION,
  HEADER_VARIANTS,
  cellStoryId,
  footnoteStoryId,
  headerStoryId,
  type Anchor,
  type DocComment,
  type DocProps,
  type ObjectData,
  type TableData,
} from './objects';
import { Story } from './story';
import { TextStyleTable, type ListDef, type NamedStyle } from './styles';

export const SNAPSHOT_VERSION = 1;

/** A whole document as JSON, deterministic: equal documents give equal snapshots. */
export interface DocSnapshot {
  version: number;
  props: DocProps;
  styles: Record<string, NamedStyle>;
  lists: Record<string, ListDef>;
  stories: Record<string, StoryContent>;
  tables: Record<string, TableData>;
  anchors: Anchor[];
  /** Comments and replies, by id order (absent when there are none). */
  comments?: DocComment[];
}

export class DocModel {
  props: DocProps;
  readonly styles = new Map<string, NamedStyle>();
  readonly lists = new Map<string, ListDef>();
  readonly stories = new Map<string, Story>();
  readonly tables = new Map<string, TableData>();
  readonly anchors = new Map<string, Anchor>();
  readonly comments = new Map<string, DocComment>();
  readonly textStyles = new TextStyleTable();

  private constructor(props: DocProps) {
    this.props = props;
  }

  /** A new, empty document: one empty paragraph, the built-in styles and lists. */
  static create(): DocModel {
    const doc = new DocModel({ section: { ...DEFAULT_SECTION } });
    for (const [id, style] of Object.entries(BUILT_IN_STYLES)) doc.styles.set(id, style);
    doc.lists.set('bullet', bulletList());
    doc.lists.set('numbered', numberedList());
    doc.lists.set('check', checkList());
    doc.stories.set(BODY, emptyStory(BODY, doc.textStyles));
    return doc;
  }

  static fromSnapshot(snapshot: DocSnapshot): DocModel {
    if (snapshot.version !== SNAPSHOT_VERSION) throw new Error(`Unsupported document snapshot version ${snapshot.version}`);
    const doc = new DocModel(structuredClone(snapshot.props));
    for (const [id, s] of Object.entries(snapshot.styles)) doc.styles.set(id, s);
    for (const [id, l] of Object.entries(snapshot.lists)) doc.lists.set(id, l);
    for (const [id, t] of Object.entries(snapshot.tables)) doc.tables.set(id, structuredClone(t));
    for (const [id, c] of Object.entries(snapshot.stories)) doc.stories.set(id, Story.from(id, contentToPiece(c, doc.textStyles)));
    for (const a of snapshot.anchors) doc.anchors.set(a.id, { ...a });
    for (const c of snapshot.comments ?? []) doc.comments.set(c.id, structuredClone(c));
    if (!doc.stories.has(BODY)) doc.stories.set(BODY, emptyStory(BODY, doc.textStyles));
    return doc;
  }

  toSnapshot(): DocSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      props: structuredClone(this.props),
      styles: sortedRecord(this.styles),
      lists: sortedRecord(this.lists),
      stories: Object.fromEntries(
        [...this.stories.keys()].sort().map((id) => [id, this.storyContent(id)]),
      ),
      tables: Object.fromEntries([...this.tables.keys()].sort().map((id) => [id, tidyTable(this.tables.get(id)!)])),
      anchors: [...this.anchors.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => ({ ...a })),
      ...(this.comments.size ? { comments: [...this.comments.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => structuredClone(c)) } : {}),
    };
  }

  get body(): Story {
    return this.stories.get(BODY)!;
  }

  story(id: string): Story | undefined {
    return this.stories.get(id);
  }

  /** The content of [from, to) of a story, without what its objects own. */
  storyContent(id: string, from = 0, to?: number): StoryContent {
    const story = this.stories.get(id);
    if (!story) return { text: '' };
    return pieceToContent(story.slice(from, to ?? story.length), this.textStyles);
  }

  /** The content of [from, to) of a story, with everything its objects own (for a delete's inverse, copy). */
  extract(id: string, from: number, to: number): Content {
    const content: Content = this.storyContent(id, from, to);
    const owned = this.collectOwned(id, from, to);
    if (Object.keys(owned.tables).length) content.tables = owned.tables;
    if (Object.keys(owned.stories).length) content.stories = owned.stories;
    return content;
  }

  /** Story ids an object owns (that exist). */
  ownedStoryIds(obj: ObjectData): string[] {
    switch (obj.kind) {
      case 'table': {
        const table = this.tables.get(obj.id);
        if (!table) return [];
        const ids: string[] = [];
        for (const r of table.rows) for (const c of table.cols) ids.push(cellStoryId(obj.id, r.id, c.id));
        return ids;
      }
      case 'footnote':
        return [footnoteStoryId(obj.id)].filter((id) => this.stories.has(id));
      case 'sectionBreak':
        return sectionStoryIds(obj.id).filter((id) => this.stories.has(id));
      default:
        return [];
    }
  }

  /** Tables and stories owned by the objects in [from, to) of a story, recursively. */
  collectOwned(id: string, from: number, to: number): { tables: Record<string, TableData>; stories: Record<string, StoryContent> } {
    const tables: Record<string, TableData> = {};
    const stories: Record<string, StoryContent> = {};
    const visit = (storyId: string, start: number, end: number) => {
      const story = this.stories.get(storyId);
      if (!story) return;
      story.forEachAttr(start, end, (pos, attr) => {
        if (story.charAt(pos) !== OBJECT) return;
        const obj = attr as ObjectData;
        if (obj.kind === 'table') {
          const t = this.tables.get(obj.id);
          if (t) tables[obj.id] = structuredClone(t);
        }
        for (const sid of this.ownedStoryIds(obj)) {
          const s = this.stories.get(sid);
          if (!s || stories[sid]) continue;
          stories[sid] = this.storyContent(sid);
          visit(sid, 0, s.length);
        }
      });
    };
    visit(id, from, to);
    return { tables, stories };
  }

  /** Creates the tables and stories `content` carries (an insert, a restore). */
  addOwned(content: Pick<Content, 'tables' | 'stories'>): void {
    for (const [id, t] of Object.entries(content.tables ?? {})) this.tables.set(id, structuredClone(t));
    for (const [id, c] of Object.entries(content.stories ?? {})) this.stories.set(id, Story.from(id, contentToPiece(c, this.textStyles)));
    // A table's cells always exist, empty when the content had nothing for them.
    for (const [id, t] of Object.entries(content.tables ?? {})) this.ensureCells(id, t);
  }

  /** Deletes the tables and stories owned by the objects in [from, to) of a story. */
  removeOwned(id: string, from: number, to: number): void {
    const owned = this.collectOwned(id, from, to);
    for (const tid of Object.keys(owned.tables)) this.tables.delete(tid);
    for (const sid of Object.keys(owned.stories)) this.stories.delete(sid);
  }

  /** Creates the empty stories of any cell of a table that has none. */
  ensureCells(tableId: string, table: TableData): void {
    for (const r of table.rows) {
      for (const c of table.cols) {
        const sid = cellStoryId(tableId, r.id, c.id);
        if (!this.stories.has(sid)) this.stories.set(sid, emptyStory(sid, this.textStyles));
      }
    }
  }

  /** Every id in use by a table, story or id-carrying object (fresh ids must avoid these). */
  hasId(id: string): boolean {
    return this.tables.has(id) || this.stories.has(id) || this.stories.has(footnoteStoryId(id)) || sectionStoryIds(id).some((s) => this.stories.has(s));
  }
}

/** A story holding one empty paragraph: what every story starts as. */
export function emptyStory(id: string, table: TextStyleTable): Story {
  return Story.from(id, contentToPiece({ text: PARA }, table));
}

export function sectionStoryIds(sectionId: string): string[] {
  const ids: string[] = [];
  for (const variant of HEADER_VARIANTS) {
    ids.push(headerStoryId(sectionId, 'header', variant), headerStoryId(sectionId, 'footer', variant));
  }
  return ids;
}

/** A copy without empty `cells` / `props`, so equal tables give equal snapshots however they got there. */
function tidyTable(table: TableData): TableData {
  const out = structuredClone(table);
  if (out.cells && Object.keys(out.cells).length === 0) delete out.cells;
  if (out.props && Object.keys(out.props).length === 0) delete out.props;
  return out;
}

function sortedRecord<T>(map: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...map.keys()].sort().map((k) => [k, structuredClone(map.get(k)!)]));
}
