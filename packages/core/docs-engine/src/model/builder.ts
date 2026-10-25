/**
 * Builds content piece by piece: what the HTML and Markdown readers, the
 * .docx reader and tests use to produce an insertable fragment.
 */

import { OBJECT, PARA } from './chars';
import type { Content, StoryContent } from './content';
import { newId } from './ids';
import { cellKey, cellStoryId, type CellProps, type ObjectData, type TableData, type TableProps } from './objects';
import { isEmptyObject, sameValue, type ListDef, type ParaProps, type TextStyle } from './styles';

/** Content to insert, with the list definitions its paragraphs refer to that the document may not have yet. */
export interface Fragment {
  content: Content;
  lists?: Record<string, ListDef>;
}

export interface TableCellInput {
  content: Content;
  props?: CellProps;
}

export class ContentBuilder {
  private text = '';
  private readonly runs: [number, TextStyle][] = [];
  private readonly paras: [number, ParaProps][] = [];
  private readonly objects: [number, ObjectData][] = [];
  private readonly tables: Record<string, TableData> = {};
  private readonly stories: Record<string, StoryContent> = {};

  constructor(private readonly makeId: () => string = newId) {}

  get length(): number {
    return this.text.length;
  }

  /** True when nothing follows the last paragraph mark (or nothing was added). */
  get atParagraphStart(): boolean {
    return this.text.length === 0 || this.text.endsWith(PARA);
  }

  /** Last character added. */
  get last(): string {
    return this.text[this.text.length - 1] ?? '';
  }

  addText(text: string, style: TextStyle = {}): this {
    if (!text) return this;
    this.pushRun(text.length, style);
    this.text += text;
    return this;
  }

  /** Ends the current paragraph with these properties. */
  endParagraph(props: ParaProps = {}, markStyle: TextStyle = {}): this {
    if (!isEmptyObject(props)) this.paras.push([this.text.length, props]);
    this.pushRun(1, markStyle);
    this.text += PARA;
    return this;
  }

  addObject(data: ObjectData, style: TextStyle = {}): this {
    this.objects.push([this.text.length, data]);
    this.pushRun(1, style);
    this.text += OBJECT;
    return this;
  }

  /** Adds a table object; each cell's content becomes that cell's story (an empty paragraph when it has none). */
  addTable(rows: TableCellInput[][], options: { widths?: number[]; props?: TableProps; headerRows?: number } = {}): string {
    const id = this.makeId();
    const colCount = Math.max(1, ...rows.map((r) => r.length));
    const width = options.widths;
    const table: TableData = {
      rows: rows.map((_, i) => ({ id: this.makeId(), ...(i < (options.headerRows ?? 0) ? { header: true } : {}) })),
      cols: Array.from({ length: colCount }, (_, i) => ({ id: this.makeId(), width: width?.[i] ?? 451 / colCount })),
    };
    if (options.props) table.props = options.props;
    const cells: Record<string, CellProps> = {};
    rows.forEach((row, ri) => {
      for (let ci = 0; ci < colCount; ci++) {
        const cell = row[ci];
        const rowId = table.rows[ri]!.id;
        const colId = table.cols[ci]!.id;
        const content = cell?.content ?? { text: PARA };
        const { tables, stories, ...story } = content;
        this.stories[cellStoryId(id, rowId, colId)] = story.text.endsWith(PARA) ? story : appendPara(story);
        Object.assign(this.tables, tables);
        Object.assign(this.stories, stories);
        if (cell?.props && !isEmptyObject(cell.props)) cells[cellKey(rowId, colId)] = cell.props;
      }
    });
    if (Object.keys(cells).length) table.cells = cells;
    this.tables[id] = table;
    this.addObject({ kind: 'table', id });
    return id;
  }

  /** Appends content built elsewhere (with what it owns). */
  append(content: Content): this {
    const base = this.text.length;
    for (const [len, style] of content.runs ?? []) this.pushRun(len, style);
    const styled = (content.runs ?? []).reduce((n, [len]) => n + len, 0);
    if (content.text.length > styled) this.pushRun(content.text.length - styled, {});
    for (const [o, p] of content.paras ?? []) this.paras.push([base + o, p]);
    for (const [o, d] of content.objects ?? []) this.objects.push([base + o, d]);
    Object.assign(this.tables, content.tables);
    Object.assign(this.stories, content.stories);
    this.text += content.text;
    return this;
  }

  build(): Content {
    const out: Content = { text: this.text };
    const runs = this.runs.filter(([len]) => len > 0);
    while (runs.length && isEmptyObject(runs[runs.length - 1]![1])) runs.pop();
    if (runs.length) out.runs = runs;
    if (this.paras.length) out.paras = this.paras;
    if (this.objects.length) out.objects = this.objects;
    if (Object.keys(this.tables).length) out.tables = this.tables;
    if (Object.keys(this.stories).length) out.stories = this.stories;
    return out;
  }

  private pushRun(len: number, style: TextStyle): void {
    const last = this.runs[this.runs.length - 1];
    if (last && sameValue(last[1], style)) last[0] += len;
    else this.runs.push([len, style]);
  }
}

function appendPara(content: StoryContent): StoryContent {
  return { ...content, text: content.text + PARA };
}
