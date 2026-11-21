import type { Point } from '@weldsuite/board-engine';
import type { BoardController } from './model/board-controller';
import { cutSelection, encodeClipboard, fragmentFromHtml, pasteFragment, pasteText } from './model/clipboard';

/**
 * Copy, cut and paste from a menu, through the async Clipboard API (the keys
 * go through the copy and paste events instead). Board content is written as
 * HTML that carries the elements, with readable text beside it; where a
 * browser can't write HTML, the text alone. Each resolves to whether it
 * worked: a browser may refuse, and then the keys still do.
 */

export async function copyToClipboard(c: BoardController): Promise<boolean> {
  const data = encodeClipboard(c);
  if (!data || !navigator.clipboard) return false;
  try {
    if (data.html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([data.text], { type: 'text/plain' }),
          'text/html': new Blob([data.html], { type: 'text/html' }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(data.text);
    }
    return true;
  } catch {
    return false;
  }
}

export async function cutToClipboard(c: BoardController): Promise<boolean> {
  if (!(await copyToClipboard(c))) return false;
  cutSelection(c);
  return true;
}

/** Pastes what the clipboard holds, centred on `at`. */
export async function pasteFromClipboard(c: BoardController, at: Point): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    if (!navigator.clipboard.read) {
      const text = await navigator.clipboard.readText();
      if (text) pasteText(c, text, at);
      return Boolean(text);
    }
    for (const item of await navigator.clipboard.read()) {
      if (await pasteItem(c, item, at)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Pastes one clipboard item: board content from its HTML, else its text. */
async function pasteItem(c: BoardController, item: ClipboardItem, at: Point): Promise<boolean> {
  if (item.types.includes('text/html')) {
    const fragment = fragmentFromHtml(await (await item.getType('text/html')).text());
    if (fragment) {
      pasteFragment(c, fragment, at);
      return true;
    }
  }
  if (!item.types.includes('text/plain')) return false;
  pasteText(c, await (await item.getType('text/plain')).text(), at);
  return true;
}
