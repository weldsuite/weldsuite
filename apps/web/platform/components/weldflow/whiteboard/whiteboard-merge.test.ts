import { describe, expect, it } from 'vitest';
import {
  applyDelta,
  applyRemoteAdd,
  applyRemoteDelete,
  applyRemoteUpdate,
  diffElements,
  mergeScenes,
} from './whiteboard-merge';

interface El {
  id: string;
  x: number;
}
const el = (id: string, x = 0): El => ({ id, x });

describe('diffElements / applyDelta', () => {
  it('describes added, removed and changed elements', () => {
    const delta = diffElements([el('a'), el('b', 1)], [el('b', 2), el('c')]);
    expect(delta.removed).toEqual(['a']);
    expect(delta.changed).toEqual([el('b', 2)]);
    expect(delta.added).toEqual([{ element: el('c'), index: 1 }]);
  });

  it('undo only reverts the local change and keeps collaborators work', () => {
    // history: step 0 has A, step 1 has A + B (local add). A collaborator then added C.
    const step0 = [el('a')];
    const step1 = [el('a'), el('b')];
    const current = [el('a'), el('b'), el('c')];
    const undone = applyDelta(current, diffElements(step1, step0));
    expect(undone.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('redo re-adds at the original position', () => {
    const before = [el('a'), el('b')];
    const after = [el('a'), el('x'), el('b')];
    expect(applyDelta(before, diffElements(before, after)).map((e) => e.id)).toEqual(['a', 'x', 'b']);
  });

  it('does not resurrect an element a collaborator deleted', () => {
    const from = [el('a', 1)];
    const to = [el('a', 2)];
    expect(applyDelta([], diffElements(from, to))).toEqual([]);
  });

  it('returns the same array for an empty delta', () => {
    const current = [el('a')];
    expect(applyDelta(current, diffElements(current, [el('a')]))).toBe(current);
  });
});

describe('remote operations', () => {
  it('ignores duplicate adds and unknown updates/deletes', () => {
    const scene = [el('a')];
    expect(applyRemoteAdd(scene, el('a', 9))).toBe(scene);
    expect(applyRemoteUpdate(scene, 'zzz', { x: 1 })).toBe(scene);
    expect(applyRemoteDelete(scene, 'zzz')).toBe(scene);
  });

  it('applies add, update and delete', () => {
    let scene = applyRemoteAdd([el('a')], el('b'));
    scene = applyRemoteUpdate(scene, 'b', { x: 5 });
    scene = applyRemoteDelete(scene, 'a');
    expect(scene).toEqual([el('b', 5)]);
  });
});

describe('mergeScenes', () => {
  it('keeps a collaborators changes, additions and deletions we did not touch', () => {
    const base = [el('a'), el('b'), el('c')];
    const local = [el('a', 1), el('b'), el('c')]; // we moved a
    const server = [el('a'), el('b', 7), el('d')]; // they moved b, deleted c, added d
    expect(mergeScenes(base, local, server)).toEqual([el('a', 1), el('b', 7), el('d')]);
  });

  it('local deletion wins and local additions are kept', () => {
    const base = [el('a'), el('b')];
    const local = [el('a'), el('n')]; // deleted b, added n
    const server = [el('a'), el('b')];
    expect(mergeScenes(base, local, server)).toEqual([el('a'), el('n')]);
  });

  it('does not overwrite the server when nothing changed locally', () => {
    const base = [el('a')];
    expect(mergeScenes(base, base, [el('a', 3)])).toEqual([el('a', 3)]);
  });

  it('local edit beats a concurrent server edit of the same element', () => {
    const base = [el('a')];
    expect(mergeScenes(base, [el('a', 1)], [el('a', 2)])).toEqual([el('a', 1)]);
  });
});
