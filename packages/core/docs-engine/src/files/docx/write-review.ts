/**
 * Comments and suggestions out.
 *
 * A suggestion becomes a Word revision: its inserted text goes inside
 * `w:ins`, its deleted text inside `w:del`, with the author and date of its
 * thread. Every piece of one suggestion carries the same revision id, so it
 * reads back as one. Format suggestions have no counterpart here and are
 * written as plain text, as is a suggestion whose thread is missing.
 *
 * A comment thread becomes Word comments: the first comment and each reply
 * (their text from the document's chat, given by the caller) are
 * `w:comment`s in `word/comments.xml`, all marked on the thread's range (as
 * Word does), and `word/commentsExtended.xml` says which reply belongs to
 * which comment and which threads are resolved. A thread with nothing said
 * in it is left out.
 */

import { XML_HEADER, attrs, esc, isXmlUnsafe } from '@weldsuite/zip-xml';
import type { Anchor, DocComment } from '../../model/objects';
import type { TextStyle } from '../../model/styles';
import type { BookmarkRange } from '../../serialize/blocks';
import { NS, wordDate } from './convert';
import type { CommentText } from './types';

/** An open `w:ins` / `w:del`: the same object for every run of one suggestion of one kind. */
export interface Revision {
  tag: 'ins' | 'del';
  /** The attributes (`w:id`, `w:author`, `w:date`). */
  attrs: string;
}

/** One Word comment: a thread's first comment (its id is the thread's) or a reply (`parent` is the first one's). */
interface Entry {
  thread: DocComment;
  text: CommentText;
  parent?: string;
}

export class ReviewWriter {
  private readonly byId = new Map<string, DocComment>();
  private readonly entries = new Map<string, Entry>();
  /** Comment ranges by story: each thread's first comment, then its replies, on the thread's range. */
  private readonly ranges = new Map<string, BookmarkRange[]>();
  private readonly revisions = new Map<string, Revision>();
  private readonly revisionIds = new Map<string, number>();
  /** Word's id for each comment written, in the order they were met. */
  private readonly commentIds = new Map<string, number>();
  private nextId = 0;
  /** Off while writing a header or footer: Word has no comments there. */
  commentsOn = true;

  constructor(threads: readonly DocComment[], anchors: readonly Anchor[], said: (thread: string) => readonly CommentText[] = () => []) {
    for (const t of threads) this.byId.set(t.id, t);
    for (const a of anchors) {
      const thread = this.byId.get(a.id);
      if (a.kind !== 'comment' || !thread || thread.suggestion) continue;
      const texts = said(a.id);
      if (texts.length === 0) continue;
      const list = this.ranges.get(a.story) ?? [];
      texts.forEach((text, i) => {
        const id = i === 0 ? a.id : `${a.id}:${i}`;
        this.entries.set(id, i === 0 ? { thread, text } : { thread, text, parent: a.id });
        list.push({ id, from: a.from, to: a.to });
      });
      this.ranges.set(a.story, list);
    }
  }

  /** The comment ranges to mark in a story. */
  commentRanges(story: string): readonly BookmarkRange[] {
    return this.commentsOn ? (this.ranges.get(story) ?? []) : [];
  }

  get hasComments(): boolean {
    return this.commentIds.size > 0;
  }

  // ---------------------------------------------------------------- revisions

  /** The revision text in this style belongs to, or null when it is not suggested (or cannot be written as one). */
  revision(style: TextStyle): Revision | null {
    const s = style.suggestion;
    if (!s || s.kind === 'format') return null;
    const thread = this.byId.get(s.id);
    if (!thread) return null;
    const key = `${s.kind}:${s.id}`;
    let rev = this.revisions.get(key);
    if (!rev) {
      let id = this.revisionIds.get(s.id);
      if (id === undefined) {
        id = this.nextId++;
        this.revisionIds.set(s.id, id);
      }
      rev = { tag: s.kind === 'insert' ? 'ins' : 'del', attrs: attrs({ 'w:id': id, 'w:author': thread.author.name, 'w:date': wordDate(thread.createdAt) }) };
      this.revisions.set(key, rev);
    }
    return rev;
  }

  /** A paragraph mark's run properties: inserted or deleted, as Word marks a suggested paragraph break. */
  markRPr(style: TextStyle | undefined): string {
    const rev = style ? this.revision(style) : null;
    return rev ? `<w:rPr><w:${rev.tag}${rev.attrs}/></w:rPr>` : '';
  }

  // ---------------------------------------------------------------- comments

  /** Where a comment's range starts or ends; the end carries the comment's reference mark. */
  commentMark(id: string, edge: 'start' | 'end'): string {
    let n = this.commentIds.get(id);
    if (n === undefined) {
      n = this.nextId++;
      this.commentIds.set(id, n);
    }
    if (edge === 'start') return `<w:commentRangeStart w:id="${n}"/>`;
    return `<w:commentRangeEnd w:id="${n}"/><w:r><w:commentReference w:id="${n}"/></w:r>`;
  }

  /** `word/comments.xml` and `word/commentsExtended.xml` for the comments written. */
  parts(): { comments: string; extended: string } {
    // Paragraph ids first: a reply names the last paragraph of the comment it answers.
    let para = 0;
    const paraId = () => (++para).toString(16).toUpperCase().padStart(8, '0');
    const written = [...this.commentIds].map(([id, n]) => {
      const e = this.entries.get(id)!;
      const lines = wordText(e.text.body).split('\n').map((text) => ({ text, paraId: paraId() }));
      return { id, e, n, lines };
    });
    const paraIds = new Map(written.map((w) => [w.id, w.lines[w.lines.length - 1]!.paraId]));
    let comments = '';
    let extended = '';
    for (const { id, e, n, lines } of written) {
      let body = '';
      lines.forEach((line, i) => {
        const ref = i === 0 ? '<w:r><w:annotationRef/></w:r>' : '';
        const text = line.text ? `<w:r><w:t xml:space="preserve">${esc(line.text)}</w:t></w:r>` : '';
        body += `<w:p w14:paraId="${line.paraId}">${ref}${text}</w:p>`;
      });
      const name = e.text.author;
      comments += `<w:comment${attrs({ 'w:id': n, 'w:author': name, 'w:date': wordDate(e.text.createdAt), 'w:initials': initials(name) || undefined })}>${body}</w:comment>`;
      const parent = e.parent ? paraIds.get(e.parent) : undefined;
      extended += `<w15:commentEx${attrs({ 'w15:paraId': paraIds.get(id), 'w15:paraIdParent': parent, 'w15:done': e.thread.resolved ? '1' : '0' })}/>`;
    }
    const ns = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:w14="${NS.w14}" xmlns:mc="${NS.mc}" mc:Ignorable="w14"`;
    return {
      comments: `${XML_HEADER}<w:comments ${ns}>${comments}</w:comments>`,
      extended: `${XML_HEADER}<w15:commentsEx xmlns:mc="${NS.mc}" xmlns:w15="${NS.w15}" mc:Ignorable="w15">${extended}</w15:commentsEx>`,
    };
  }
}

/** A comment's text as Word keeps it: line ends as `\n`, nothing XML cannot hold. */
function wordText(body: string): string {
  let out = '';
  for (const ch of body.replace(/\r\n?/g, '\n')) if (!isXmlUnsafe(ch.codePointAt(0)!)) out += ch;
  return out;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0]!)
    .join('')
    .toUpperCase()
    .slice(0, 9);
}
