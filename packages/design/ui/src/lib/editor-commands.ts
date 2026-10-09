/**
 * Formatting commands for the contentEditable rich-text editors (notes, documents, mail,
 * chat, task descriptions).
 *
 * `document.execCommand` and `document.queryCommandState` are deprecated, but every browser
 * still ships them and there is no standard replacement for formatting a contentEditable
 * selection: dropping them means moving each editor to an editor library. Until then all
 * editors go through these two functions, so the dependency lives in one place.
 */

/** Applies a formatting command (bold, insertText, createLink, …) to the current selection. */
export function runEditorCommand(command: string, value?: string): boolean {
  return document.execCommand(command, false, value);
}

/** Whether a toggle command (bold, italic, insertUnorderedList, …) is on for the selection. */
export function isEditorCommandActive(command: string): boolean {
  return document.queryCommandState(command);
}
