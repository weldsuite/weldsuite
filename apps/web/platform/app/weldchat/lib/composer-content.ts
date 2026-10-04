/**
 * Content ↔ editor-DOM helpers for the WeldChat composer.
 *
 * The composer is a `contentEditable` div. Its model is a plain string where
 * mentions are inline `<@…>` tokens and formatting is markdown-ish markers
 * (`**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``).
 *
 *  - `editorToContent` / `htmlToContent` serialise the editor DOM to that string.
 *  - `contentToFragment` / `contentToHtml` go the other way, building DOM nodes
 *    (never concatenating user text into HTML), so typed text can't inject markup.
 *    Markdown markers come back as typed text, not as `<b>`/`<i>` elements.
 *  - `replaceMentionQuery` swaps the `@query` text at the caret for a chip node
 *    without touching the rest of the editor.
 */

import { parseChatTokens, encodeEntityToken } from './render-tokens';
import type { EntitySheetType } from '@/components/entity-sheet/types';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** HTML-escape a string for inclusion in attribute values / element bodies. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** User-mention chip. `body` is the token body (`userId` or `userId:Name`). */
export function createUserBadge(body: string, displayName: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'mention-badge';
  el.setAttribute('contenteditable', 'false');
  el.dataset.userid = body;
  el.textContent = `@${displayName}`;
  return el;
}

/** Entity-reference chip (`<@type:id|Label>`). */
export function createEntityBadge(type: string, id: string, label: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'entity-mention-badge';
  el.setAttribute('contenteditable', 'false');
  el.dataset.entity = `${type}:${id}`;
  el.dataset.label = label;
  el.textContent = label || `${type}:${id}`;
  return el;
}

// ---------------------------------------------------------------------------
// Content → DOM
// ---------------------------------------------------------------------------

/** Build editor nodes for raw content: text as text nodes, `<@…>` tokens as chips. */
export function contentToFragment(text: string, membersMap: Map<string, string>): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const seg of parseChatTokens(text)) {
    if (seg.kind === 'text') {
      fragment.appendChild(document.createTextNode(seg.text));
    } else if (seg.kind === 'entity') {
      fragment.appendChild(createEntityBadge(seg.entityType, seg.entityId, seg.label ?? ''));
    } else if (seg.userId === 'everyone' && !seg.displayName) {
      // Special-cased so the chip stays correct even if a workspace member
      // ever has the literal userId 'everyone'.
      fragment.appendChild(createUserBadge('everyone', 'everyone'));
    } else {
      const body = seg.displayName ? `${seg.userId}:${seg.displayName}` : seg.userId;
      fragment.appendChild(createUserBadge(body, seg.displayName ?? membersMap.get(seg.userId) ?? seg.userId));
    }
  }
  return fragment;
}

/** Raw content as editor HTML. Text is escaped by the DOM serialiser, never interpolated. */
export function contentToHtml(text: string, membersMap: Map<string, string>): string {
  const holder = document.createElement('div');
  holder.appendChild(contentToFragment(text, membersMap));
  return holder.innerHTML;
}

/** Replace the editor's content with `text`, rendering mention tokens as chips. */
export function loadContentIntoEditor(editor: HTMLElement, text: string, membersMap: Map<string, string>): void {
  editor.replaceChildren(contentToFragment(text, membersMap));
}

/** Put the caret at the end of the editor. */
export function placeCaretAtEnd(editor: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Mentions the server should be told about, derived from the content's tokens. */
export function extractMentions(content: string): string[] {
  const out: string[] = [];
  const add = (entry: string) => {
    if (!out.includes(entry)) out.push(entry);
  };
  for (const seg of parseChatTokens(content)) {
    if (seg.kind === 'user') add(seg.userId);
    else if (seg.kind === 'entity') add(`entity:${seg.entityType}:${seg.entityId}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM → content
// ---------------------------------------------------------------------------

/** Wrap with a markdown marker, keeping edge whitespace outside so the marker stays valid. */
function mark(marker: string, inner: string): string {
  if (inner.trim() === '') return inner;
  const lead = /^\s*/.exec(inner)?.[0] ?? '';
  const trail = /\s*$/.exec(inner.slice(lead.length))?.[0] ?? '';
  const core = inner.slice(lead.length, inner.length - trail.length);
  return `${lead}${marker}${core}${marker}${trail}`;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'UL', 'OL']);

/** The markdown marker an inline formatting element serialises with, if it is one. */
function markerOf(node: Node): string | null {
  if (node.nodeType !== ELEMENT_NODE) return null;
  switch ((node as Element).tagName) {
    case 'B':
    case 'STRONG':
      return '**';
    case 'I':
    case 'EM':
      return '*';
    case 'U':
      return '__';
    case 'S':
    case 'STRIKE':
    case 'DEL':
      return '~~';
    default:
      return null;
  }
}

function serializeChildren(parent: Node): string {
  let out = '';
  // Marker of the formatting element that ended `out` (nothing in between), so
  // two adjacent runs of the same format merge: <b>a</b><b>b</b> → **ab**.
  let prevMarker: string | null = null;
  parent.childNodes.forEach((child) => {
    const isBlock = child.nodeType === ELEMENT_NODE && BLOCK_TAGS.has((child as Element).tagName);
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
    const piece = serializeNode(child);
    const marker = markerOf(child);
    const wrapped = !!marker && piece.length > marker.length * 2 && piece.startsWith(marker) && piece.endsWith(marker);
    if (wrapped && marker === prevMarker && out.endsWith(marker)) {
      out = out.slice(0, -marker.length) + piece.slice(marker.length);
    } else {
      out += piece;
    }
    prevMarker = wrapped ? marker : null;
    if (isBlock && !out.endsWith('\n')) out += '\n';
  });
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === TEXT_NODE) return (node.nodeValue ?? '').replace(/\u00A0/g, ' ');
  if (node.nodeType !== ELEMENT_NODE) return '';

  const el = node as HTMLElement;

  if (el.classList.contains('entity-mention-badge')) {
    const entity = el.dataset.entity; // "type:id"
    const colonIdx = entity?.indexOf(':') ?? -1;
    if (entity && colonIdx > 0) {
      const label = el.dataset.label || el.textContent || '';
      // encodeEntityToken sanitises the label (strips `|`/`>`, trims, max 80 chars).
      // The type is runtime-checked when the token is parsed again.
      return encodeEntityToken(entity.slice(0, colonIdx) as EntitySheetType, entity.slice(colonIdx + 1), label);
    }
    return el.textContent ?? '';
  }
  if (el.classList.contains('mention-badge')) {
    const userId = el.dataset.userid;
    return userId ? `<@${userId}>` : (el.textContent ?? '');
  }

  switch (el.tagName) {
    case 'BR':
      return '\n';
    case 'B':
    case 'STRONG':
      return mark('**', serializeChildren(el));
    case 'I':
    case 'EM':
      return mark('*', serializeChildren(el));
    case 'U':
      return mark('__', serializeChildren(el));
    case 'S':
    case 'STRIKE':
    case 'DEL':
      return mark('~~', serializeChildren(el));
    case 'CODE': {
      const text = (el.textContent ?? '').replace(/\u200B/g, '');
      return text ? `\`${text}\`` : '';
    }
    case 'UL':
    case 'OL': {
      const ordered = el.tagName === 'OL';
      return Array.from(el.children)
        .filter((li) => li.tagName === 'LI')
        .map((li, i) => `${ordered ? `${i + 1}.` : '•'} ${serializeChildren(li).replace(/\n+$/, '')}`)
        .join('\n');
    }
    case 'IMG':
      return '';
    default:
      return serializeChildren(el);
  }
}

/** Serialise the live editor DOM to raw content. */
export function editorToContent(editor: HTMLElement): string {
  return serializeChildren(editor);
}

/** Serialise editor HTML to raw content (see {@link editorToContent}). */
export function htmlToContent(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return serializeChildren(div);
}

// ---------------------------------------------------------------------------
// Caret / mention helpers
// ---------------------------------------------------------------------------

interface CaretTextPosition {
  node: Text;
  offset: number;
}

/** The text node + offset holding a collapsed caret inside `editor`, if any. */
function caretTextPosition(editor: HTMLElement): CaretTextPosition | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.startContainer)) return null;

  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === TEXT_NODE) return { node: startContainer as Text, offset: startOffset };

  // Caret sits between nodes (e.g. right after an inserted "@" text node).
  const prev = startContainer.childNodes[startOffset - 1];
  if (prev?.nodeType === TEXT_NODE) return { node: prev as Text, offset: (prev as Text).length };
  return null;
}

/** Locate the `@query` the caret is at the end of: `[atIndex, caret)` of `node`. */
function findMentionRange(editor: HTMLElement): (CaretTextPosition & { atIndex: number }) | null {
  const pos = caretTextPosition(editor);
  if (!pos) return null;
  const before = pos.node.data.slice(0, pos.offset);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null;
  if (/\s/.test(before.slice(atIndex + 1))) return null;
  return { ...pos, atIndex };
}

/** The text typed after an `@` at the caret, or null when the caret isn't in a mention query. */
export function getMentionQueryAtCaret(editor: HTMLElement): string | null {
  const found = findMentionRange(editor);
  return found ? found.node.data.slice(found.atIndex + 1, found.offset) : null;
}

/**
 * Replace the `@query` at the caret with `chip` followed by a space, leaving
 * every other node in the editor untouched. The caret ends up after the space.
 * Returns false (and changes nothing) when the caret is not in a mention query.
 */
export function replaceMentionQuery(editor: HTMLElement, chip: Node): boolean {
  const found = findMentionRange(editor);
  if (!found) return false;
  const { node, offset, atIndex } = found;
  const parent = node.parentNode;
  if (!parent) return false;

  const tail = document.createTextNode(` ${node.data.slice(offset)}`);
  node.data = node.data.slice(0, atIndex);
  parent.insertBefore(chip, node.nextSibling);
  parent.insertBefore(tail, chip.nextSibling);

  const range = document.createRange();
  range.setStart(tail, 1);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return true;
}
