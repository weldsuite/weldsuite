import { describe, expect, it } from 'vitest';
import { anchorKey, commentAnchor, lineCount, parsePatch, splitPath } from './diff';

const PATCH = [
  '@@ -1,4 +1,5 @@ function a() {',
  ' keep',
  '-old',
  '+new',
  '+extra',
  ' tail',
  '@@ -20,2 +21,2 @@',
  ' x',
  '-y',
  '\\ No newline at end of file',
  '+z',
  '',
].join('\n');

describe('parsePatch', () => {
  it('returns nothing for a missing patch', () => {
    expect(parsePatch(null)).toEqual([]);
    expect(parsePatch('')).toEqual([]);
  });

  it('numbers lines on both sides across hunks', () => {
    const [first, second] = parsePatch(PATCH);
    expect(first.section).toBe('function a() {');
    expect(first.lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
    ]);
    expect(second.oldStart).toBe(20);
    expect(second.newStart).toBe(21);
    expect(second.lines.map((l) => [l.kind, l.oldNumber, l.newNumber])).toEqual([
      ['context', 20, 21],
      ['del', 21, null],
      ['meta', null, null],
      ['add', null, 22],
    ]);
    expect(lineCount([first, second])).toBe(9);
  });

  it('keeps blank context lines and drops the trailing empty string', () => {
    const [hunk] = parsePatch('@@ -1,3 +1,3 @@\n a\n\n b\n');
    expect(hunk.lines.map((l) => l.text)).toEqual(['a', '', 'b']);
  });

  it('handles hunks without counts and CRLF line ends', () => {
    const [hunk] = parsePatch('@@ -5 +5 @@\r\n-a\r\n+b');
    expect(hunk.lines.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['del', 'a', 5, null],
      ['add', 'b', null, 5],
    ]);
  });

  it('ignores anything before the first hunk', () => {
    expect(parsePatch('diff --git a b\n--- a\n+++ b\n@@ -1 +1 @@\n+x')[0].lines).toHaveLength(1);
  });
});

describe('commentAnchor', () => {
  it('puts removed lines on the left and everything else on the right', () => {
    const [hunk] = parsePatch(PATCH);
    expect(commentAnchor(hunk.lines[1])).toEqual({ side: 'LEFT', line: 2 });
    expect(commentAnchor(hunk.lines[2])).toEqual({ side: 'RIGHT', line: 2 });
    expect(commentAnchor(hunk.lines[4])).toEqual({ side: 'RIGHT', line: 4 });
    expect(commentAnchor({ kind: 'meta', text: '', oldNumber: null, newNumber: null })).toBeNull();
  });
});

describe('helpers', () => {
  it('builds distinct anchor keys and splits paths', () => {
    expect(anchorKey('a.ts', 'LEFT', 1)).not.toBe(anchorKey('a.ts', 'RIGHT', 1));
    expect(splitPath('src/app/a.ts')).toEqual({ dir: 'src/app/', name: 'a.ts' });
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });
});
