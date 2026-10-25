import { describe, expect, it } from 'vitest';
import { OBJECT, PARA } from '../model/chars';
import { DocModel, type DocSnapshot } from '../model/document';
import { BODY, cellStoryId } from '../model/objects';
import { applyOp } from './apply';
import { isWellFormedSnapshot } from './snapshot-shape';

function tableSnapshot(): DocSnapshot {
  const doc = DocModel.create();
  applyOp(doc, {
    type: 'insert',
    story: BODY,
    at: 0,
    content: {
      text: `${OBJECT}${PARA}`,
      objects: [[0, { kind: 'table', id: 't1' }]],
      tables: { t1: { rows: [{ id: 'r1' }], cols: [{ id: 'c1', width: 100 }] } },
      stories: { [cellStoryId('t1', 'r1', 'c1')]: { text: `cell${PARA}` } },
    },
  });
  return doc.toSnapshot();
}

describe('isWellFormedSnapshot', () => {
  it('accepts a new document and one with a table', () => {
    expect(isWellFormedSnapshot(DocModel.create().toSnapshot())).toBe(true);
    expect(isWellFormedSnapshot(tableSnapshot())).toBe(true);
  });

  it('refuses a javascript: link', () => {
    const snapshot = DocModel.create().toSnapshot();
    snapshot.stories[BODY] = { text: `click${PARA}`, runs: [[5, { link: 'javascript:alert(1)' }]] };
    expect(isWellFormedSnapshot(snapshot)).toBe(false);
  });

  it('refuses a table without rows or with duplicate column ids', () => {
    const empty = tableSnapshot();
    empty.tables.t1 = { ...empty.tables.t1!, rows: [] };
    expect(isWellFormedSnapshot(empty)).toBe(false);

    const duplicate = tableSnapshot();
    duplicate.tables.t1 = { ...duplicate.tables.t1!, cols: [{ id: 'c1', width: 100 }, { id: 'c1', width: 50 }] };
    expect(isWellFormedSnapshot(duplicate)).toBe(false);
  });

  it('refuses a missing body, a story without its paragraph mark, and missing parts', () => {
    const noBody = DocModel.create().toSnapshot();
    delete noBody.stories[BODY];
    expect(isWellFormedSnapshot(noBody)).toBe(false);

    const noMark = DocModel.create().toSnapshot();
    noMark.stories[BODY] = { text: 'no mark' };
    expect(isWellFormedSnapshot(noMark)).toBe(false);

    const { styles: _styles, ...noStyles } = DocModel.create().toSnapshot();
    expect(isWellFormedSnapshot(noStyles)).toBe(false);
    expect(isWellFormedSnapshot({ ...DocModel.create().toSnapshot(), version: 99 })).toBe(false);
    expect(isWellFormedSnapshot(null)).toBe(false);
  });

  it('refuses page setup without a section and an unknown style field', () => {
    const noSection = DocModel.create().toSnapshot() as unknown as Record<string, unknown>;
    noSection.props = { pageless: true };
    expect(isWellFormedSnapshot(noSection)).toBe(false);

    const badStyle = DocModel.create().toSnapshot() as unknown as { styles: Record<string, unknown> };
    badStyle.styles.evil = { name: 'Evil', script: '<script>' };
    expect(isWellFormedSnapshot(badStyle)).toBe(false);
  });
});
