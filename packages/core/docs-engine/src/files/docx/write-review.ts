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
 * are `w:comment`s in `word/comments.xml`, all marked on the thread's range
 * (as Word does), and `word/commentsExtended.xml` says which reply belongs
 * to which comment and which threads are resolved. Mentions are written as
 * the text they show (`@Name`).
 */

import { XML_HEADER, attrs, esc, isXmlUnsafe } from '@weldsuite/zip-xml';
import type { Anchor, DocComment } from '../../model/objects';
import type { TextStyle } from '../../model/styles';
import type { BookmarkRange } from '../../serialize/blocks';
import { NS, wordDate } from './convert';

/** An open `w:ins` / `w:del`: the same object for every run of one suggestion of one kind. */
export interface Revision {
  tag: 'ins' | 'del';
  /** The attributes (`w:id`, `w:author`, `w:date`). */
  attrs: string;
}

const MENTION = /@\[([^\]]*)\]\([^)]*\)/g;

export class ReviewWriter {
  private readonly byId = new Map<string, DocComment>();
  private readonly replies = new Map<string, DocComment[]>();
  /** Comment ranges by story: each thread's first comment, then its replies, on the thread's range. */
  private readonly ranges = new Map<string, BookmarkRange[]>();
  private readonly revisions = new Map<string, Revision>();
  private readonly revisionIds = new Map<string, number>();
  /** Word's id for each comment written, in the order they were met. */
  private readonly commentIds = new Map<string, number>();
  private nextId = 0;
  /** Off while writing a header or footer: Word has no comments there. */
  commentsOn = true;

  constructor(comments: readonly DocComment[], anchors: readonly Anchor[]) {
    for (const c of comments) {
      this.byId.set(c.id, c);
      if (c.thread === c.id) continue;
      const list = this.replies.get(c.thread);
      if (list) list.push(c);
      else this.replies.set(c.thread, [c]);
    }
    for (const list of this.replies.values()) list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    for (const a of anchors) {
      const root = this.byId.get(a.id);
      if (a.kind !== 'comment' || !root || root.thread !== root.id || root.suggestion) continue;
      const list = this.ranges.get(a.story) ?? [];
      list.push({ id: a.id, from: a.from, to: a.to });
      for (const r of this.replies.get(a.id) ?? []) list.push({ id: r.id, from: a.from, to: a.to });
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
      const c = this.byId.get(id)!;
      const lines = mentionText(c.body).split('\n').map((text) => ({ text, paraId: paraId() }));
      return { c, n, lines };
    });
    const paraIds = new Map(written.map((w) => [w.c.id, w.lines[w.lines.length - 1]!.paraId]));
    let comments = '';
    let extended = '';
    for (const { c, n, lines } of written) {
      let body = '';
      lines.forEach((line, i) => {
        const ref = i === 0 ? '<w:r><w:annotationRef/></w:r>' : '';
        const text = line.text ? `<w:r><w:t xml:space="preserve">${esc(line.text)}</w:t></w:r>` : '';
        body += `<w:p w14:paraId="${line.paraId}">${ref}${text}</w:p>`;
      });
      const name = c.author.name;
      comments += `<w:comment${attrs({ 'w:id': n, 'w:author': name, 'w:date': wordDate(c.createdAt), 'w:initials': initials(name) || undefined })}>${body}</w:comment>`;
      const root = this.byId.get(c.thread);
      const parent = c.thread === c.id ? undefined : paraIds.get(c.thread);
      extended += `<w15:commentEx${attrs({ 'w15:paraId': paraIds.get(c.id), 'w15:paraIdParent': parent, 'w15:done': root?.resolved ? '1' : '0' })}/>`;
    }
    const ns = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:w14="${NS.w14}" xmlns:mc="${NS.mc}" mc:Ignorable="w14"`;
    return {
      comments: `${XML_HEADER}<w:comments ${ns}>${comments}</w:comments>`,
      extended: `${XML_HEADER}<w15:commentsEx xmlns:mc="${NS.mc}" xmlns:w15="${NS.w15}" mc:Ignorable="w15">${extended}</w15:commentsEx>`,
    };
  }
}

/** A comment's text as Word shows it: mentions as `@Name`, line ends as `\n`, nothing XML cannot hold. */
function mentionText(body: string): string {
  let out = '';
  for (const ch of body.replace(MENTION, '@$1').replace(/\r\n?/g, '\n')) if (!isXmlUnsafe(ch.codePointAt(0)!)) out += ch;
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
