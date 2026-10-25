/**
 * Comments in: Word's comments (`word/comments.xml`) become comment threads
 * on the ranges the stories marked for them, with the replies Word 2013 and
 * later record in `word/commentsExtended.xml` (`paraIdParent`) and whether a
 * thread is resolved (`done`). A comment whose place in the text is unknown
 * is left out (Word does not show it either).
 *
 * Word knows people by name only, so a name is also the author's id.
 */

import { childrenOf, type XmlElement } from '@weldsuite/zip-xml';
import { LINE_BREAK, OBJECT, PARA } from '../../model/chars';
import type { StoryContent } from '../../model/content';
import type { Anchor, DocComment } from '../../model/objects';
import { onOff, readWordDate } from './convert';

/** A comment's range as a story marked it. */
export interface CommentRange {
  story: string;
  from: number;
  to: number;
}

/** Longest comment kept, and longest quote of the text commented on (the engine's own limits). */
const MAX_BODY = 20_000;
const MAX_QUOTE = 200;
const MAX_NAME = 200;
/** Replies to replies are followed this far up to their thread. */
const MAX_DEPTH = 32;
const HIDDEN = new RegExp(`[${PARA}${LINE_BREAK}${OBJECT}]`, 'g');

/** A person as the engine keeps them, from Word's author name (or initials). */
export function authorOf(name: string | undefined): DocComment['author'] {
  const n = (name ?? '').trim().slice(0, MAX_NAME);
  return { id: n || 'unknown', name: n };
}

interface WordComment {
  word: string;
  id: string;
  author: DocComment['author'];
  createdAt: number;
  body: string;
  /** The id of its last paragraph, which commentsExtended refers to. */
  paraId?: string;
}

export interface CommentThreads {
  anchors: Anchor[];
  comments: DocComment[];
  /** Some comments were left out. */
  dropped: boolean;
}

export function readCommentThreads(
  part: XmlElement | null,
  extended: XmlElement | null,
  ranges: Map<string, CommentRange>,
  stories: Record<string, StoryContent>,
  makeId: () => string,
): CommentThreads {
  const out: CommentThreads = { anchors: [], comments: [], dropped: false };
  if (!part) return out;
  const list = readComments(part, makeId);
  const ext = readExtended(extended);
  const rootOf = threadRoots(list, ext);

  // Threads first (each on its range), then the replies of the threads kept.
  const kept = new Set<WordComment>();
  for (const c of list) {
    if (rootOf(c) !== c) continue;
    const thread = placeThread(c, ranges.get(c.word), stories, ext);
    if (thread) {
      kept.add(c);
      out.anchors.push(thread.anchor);
      out.comments.push(thread.entry);
    } else out.dropped = true;
  }
  for (const c of list) {
    const root = rootOf(c);
    if (root === c) continue;
    if (kept.has(root)) out.comments.push(commentEntry(c, root.id));
    else out.dropped = true;
  }
  return out;
}

/** The comments of `word/comments.xml`, in order, each with its engine id. */
function readComments(part: XmlElement, makeId: () => string): WordComment[] {
  const list: WordComment[] = [];
  for (const el of childrenOf(part, 'comment')) {
    if (el.attrs.id === undefined) continue;
    const paras = paragraphsOf(el);
    const c: WordComment = {
      word: el.attrs.id,
      id: makeId(),
      author: authorOf(el.attrs.author || el.attrs.initials),
      createdAt: readWordDate(el.attrs.date),
      body: paras.map(paragraphText).join('\n').slice(0, MAX_BODY),
    };
    const paraId = paras[paras.length - 1]?.attrs.paraId;
    if (paraId) c.paraId = paraId;
    list.push(c);
  }
  return list;
}

type Extended = Map<string, { parent?: string; done: boolean }>;

/** `word/commentsExtended.xml`: by a comment's last paragraph id, the comment it answers and whether it is done. */
function readExtended(extended: XmlElement | null): Extended {
  const ext: Extended = new Map();
  for (const e of childrenOf(extended ?? undefined, 'commentEx')) {
    if (e.attrs.paraId) ext.set(e.attrs.paraId, { parent: e.attrs.paraIdParent, done: e.attrs.done !== undefined && onOff(e.attrs.done) });
  }
  return ext;
}

/** The first comment of the thread each comment belongs to (itself when it answers none). */
function threadRoots(list: WordComment[], ext: Extended): (c: WordComment) => WordComment {
  const byPara = new Map(list.filter((c) => c.paraId).map((c) => [c.paraId!, c]));
  const parentOf = (c: WordComment) => (c.paraId ? byPara.get(ext.get(c.paraId)?.parent ?? '') : undefined);
  return (c) => {
    let at = c;
    for (let i = 0; i < MAX_DEPTH; i++) {
      const parent = parentOf(at);
      if (!parent || parent === c) break;
      at = parent;
    }
    return at;
  };
}

/** A thread's first comment and its anchor, or null when its range is not in a story read. */
function placeThread(
  c: WordComment,
  range: CommentRange | undefined,
  stories: Record<string, StoryContent>,
  ext: Extended,
): { anchor: Anchor; entry: DocComment } | null {
  const story = range ? stories[range.story] : undefined;
  if (!range || !story) return null;
  const entry = commentEntry(c, c.id);
  if (c.paraId && ext.get(c.paraId)?.done) entry.resolved = true;
  const quote = story.text.slice(range.from, range.to).replace(HIDDEN, ' ').trim().slice(0, MAX_QUOTE);
  if (quote) entry.quote = quote;
  return { anchor: { id: c.id, kind: 'comment', story: range.story, from: range.from, to: range.to }, entry };
}

function commentEntry(c: WordComment, thread: string): DocComment {
  return { id: c.id, thread, author: c.author, createdAt: c.createdAt, body: c.body };
}

/** The paragraphs of a comment, also those inside content controls (not those inside tables). */
function paragraphsOf(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.name === 'p') out.push(c);
    else if (c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'customXml') out.push(...paragraphsOf(c));
  }
  return out;
}

/** The text a paragraph shows: its text runs, tabs and line breaks (not deleted text or field codes). */
function paragraphText(el: XmlElement): string {
  let out = '';
  for (const c of el.children) {
    if (c.name === 't') out += c.text;
    else if (c.name === 'tab') out += '\t';
    else if (c.name === 'br' || c.name === 'cr') out += '\n';
    else if (c.name !== 'del' && c.name !== 'moveFrom') out += paragraphText(c);
  }
  return out;
}
