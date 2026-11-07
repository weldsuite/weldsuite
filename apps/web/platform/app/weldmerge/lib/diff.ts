/**
 * A small unified-diff parser for the `patch` of one file as providers return
 * it: hunk headers (`@@ -a,b +c,d @@ section`) followed by ` `, `+` and `-`
 * lines, no file headers. Gives every line its number on both sides, so a line
 * can be commented on as `{ side, line }` the way review threads are anchored.
 */

export type DiffSide = 'LEFT' | 'RIGHT';
export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** Without the leading `+`, `-` or space. */
  text: string;
  /** Line number in the old file (null for added lines and meta). */
  oldNumber: number | null;
  /** Line number in the new file (null for removed lines and meta). */
  newNumber: number | null;
}

export interface DiffHunk {
  header: string;
  /** Text after the second `@@` (usually the enclosing function). */
  section: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

export function parsePatch(patch: string | null | undefined): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  const rows = patch.replace(/\r\n/g, '\n').split('\n');
  // The empty string after the final newline is not a line.
  if (rows.at(-1) === '') rows.pop();

  for (const raw of rows) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      current = { header: raw, section: header[3] ?? '', oldStart: oldNumber, newStart: newNumber, lines: [] };
      hunks.push(current);
    } else if (current) {
      if (raw.startsWith('\\')) {
        current.lines.push({ kind: 'meta', text: raw.replace(/^\\ ?/, ''), oldNumber: null, newNumber: null });
      } else if (raw.startsWith('+')) {
        current.lines.push({ kind: 'add', text: raw.slice(1), oldNumber: null, newNumber: newNumber++ });
      } else if (raw.startsWith('-')) {
        current.lines.push({ kind: 'del', text: raw.slice(1), oldNumber: oldNumber++, newNumber: null });
      } else {
        // A context line; some providers trim a blank one to the empty string.
        current.lines.push({ kind: 'context', text: raw.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
      }
    }
  }
  return hunks;
}

/** Which side a comment on this line belongs to, and the line number there. */
export function commentAnchor(line: DiffLine): { side: DiffSide; line: number } | null {
  if (line.kind === 'meta') return null;
  if (line.kind === 'del') return line.oldNumber === null ? null : { side: 'LEFT', line: line.oldNumber };
  return line.newNumber === null ? null : { side: 'RIGHT', line: line.newNumber };
}

export function anchorKey(path: string, side: DiffSide, line: number): string {
  return `${path}\u0000${side}\u0000${line}`;
}

export function lineCount(hunks: DiffHunk[]): number {
  return hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

/** Folder and file name of a path: `src/app/` and `a.ts`. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  return index === -1 ? { dir: '', name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}
