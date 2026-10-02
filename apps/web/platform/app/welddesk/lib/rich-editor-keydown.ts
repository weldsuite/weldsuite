import type { KeyboardEvent } from 'react';

/**
 * DOM helpers shared by the WeldDesk contentEditable editors (announcements,
 * changelog). They implement the key handling that keeps paragraphs LTR and
 * lets Backspace at the start of a list item turn it back into a paragraph.
 */

/** Resolves the element the caret currently sits in (text nodes map to their parent). */
function getAnchorElement(selection: Selection): HTMLElement | null {
  const node = selection.anchorNode as HTMLElement;
  return (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) as HTMLElement | null;
}

/** True when the caret is collapsed at the very start of the list item. */
function isCaretAtListItemStart(range: Range, listItem: HTMLElement): boolean {
  if (!range.collapsed || range.startOffset !== 0) return false;
  // At the start of the list item itself or of its first text node
  return (
    range.startContainer === listItem ||
    (range.startContainer === listItem.firstChild &&
      range.startContainer.nodeType === Node.TEXT_NODE)
  );
}

/** Builds a paragraph holding the list item's content (or a zero-width space when empty). */
function createParagraphFromListItem(listItem: HTMLElement): HTMLParagraphElement {
  const html = listItem.innerHTML.replace(/^\u200B/, '').trim();
  const paragraph = document.createElement('p');
  paragraph.setAttribute('dir', 'ltr');

  if (html) {
    paragraph.innerHTML = html;
  } else {
    paragraph.appendChild(document.createTextNode('\u200B'));
  }
  return paragraph;
}

/** Removes the list item and puts the paragraph where it was (replacing the list when it becomes empty). */
function moveListItemToParagraph(list: HTMLElement, listItem: HTMLElement, paragraph: HTMLElement) {
  const nextSibling = list.nextSibling;
  const parentNode = list.parentNode;

  listItem.remove();

  if (list.children.length === 0) {
    parentNode?.replaceChild(paragraph, list);
  } else if (nextSibling) {
    parentNode?.insertBefore(paragraph, nextSibling);
  } else {
    parentNode?.appendChild(paragraph);
  }
}

function placeCaretAtStart(paragraph: HTMLElement, selection: Selection) {
  const newRange = document.createRange();
  newRange.setStart(paragraph.childNodes[0] ?? paragraph, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
}

function convertListItemToParagraph(
  e: KeyboardEvent<HTMLDivElement>,
  selection: Selection,
  listItem: HTMLElement,
  onContentChange: () => void,
) {
  const range = selection.getRangeAt(0);
  if (!isCaretAtListItemStart(range, listItem)) return;

  const list = listItem.parentElement;
  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return;

  e.preventDefault();

  const paragraph = createParagraphFromListItem(listItem);
  moveListItemToParagraph(list, listItem, paragraph);

  // Set cursor at the start of the new paragraph, then sync the content state
  setTimeout(() => {
    placeCaretAtStart(paragraph, selection);
    onContentChange();
  }, 0);
}

/**
 * Keeps the paragraph under the caret LTR and handles Backspace at the start
 * of a list item. `onContentChange` runs after the DOM was changed
 * asynchronously so the caller can re-read the editor HTML.
 */
export function handleEditorStructureKeys(
  e: KeyboardEvent<HTMLDivElement>,
  onContentChange: () => void,
) {
  const selection = window.getSelection();
  if (!selection?.anchorNode) return;

  const element = getAnchorElement(selection);
  if (element?.tagName === 'P') {
    element.setAttribute('dir', 'ltr');
    element.style.direction = 'ltr';
  }

  if (e.key === 'Backspace' && element?.tagName === 'LI') {
    convertListItemToParagraph(e, selection, element, onContentChange);
  }
}

/** Next index in a wrapping command list. */
export function nextCommandIndex(current: number, count: number): number {
  return current < count - 1 ? current + 1 : 0;
}

/** Previous index in a wrapping command list. */
export function previousCommandIndex(current: number, count: number): number {
  return current > 0 ? current - 1 : count - 1;
}
