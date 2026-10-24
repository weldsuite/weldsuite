import { describe, expect, it } from 'vitest';
import { OBJECT, PARA } from '../model/chars';
import { DocModel } from '../model/document';
import { BODY, cellStoryId } from '../model/objects';
import { counterIds, rng, snapshotKey } from '../test-support';
import { applyOp } from './apply';
import { randomOp } from './random-ops';
import { isWellFormedOp } from './shape';
import { transform } from './transform';
import type { Op } from './types';
import { validateOp } from './validate';

function docWith(text: string): DocModel {
  const doc = DocModel.create();
  applyOp(doc, { type: 'insert', story: BODY, at: 0, content: { text } });
  return doc;
}

function tableDoc(): DocModel {
  const doc = DocModel.create();
  applyOp(doc, {
    type: 'insert',
    story: BODY,
    at: 0,
    content: {
      text: `${OBJECT}${PARA}`,
      objects: [[0, { kind: 'table', id: 't' }]],
      tables: {
        t: {
          rows: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
          cols: [{ id: 'c1', width: 100 }, { id: 'c2', width: 100 }],
          cells: { 'r1:c1': { rowSpan: 3 } },
        },
      },
      stories: { [cellStoryId('t', 'r2', 'c2')]: { text: `hello${PARA}` } },
    },
  });
  return doc;
}

describe('applyOp', () => {
  it('starts every document with one empty paragraph', () => {
    const doc = DocModel.create();
    expect(doc.body.text()).toBe(PARA);
  });

  it('inserts and deletes text, and the inverses restore it exactly', () => {
    const doc = docWith('Hello world');
    const before = snapshotKey(doc);
    const inv = applyOp(doc, { type: 'delete', story: BODY, from: 5, to: 11 });
    expect(doc.body.text()).toBe(`Hello${PARA}`);
    applyOp(doc, inv);
    expect(snapshotKey(doc)).toBe(before);
  });

  it('formats text and paragraphs with exact inverses', () => {
    const doc = docWith(`One${PARA}Two`);
    const before = snapshotKey(doc);
    const inv1 = applyOp(doc, { type: 'formatText', story: BODY, at: 1, runs: [[4, { bold: true }]] });
    const inv2 = applyOp(doc, { type: 'formatParagraphs', story: BODY, at: 0, runs: [[8, { style: 'heading1', align: 'center' }]] });
    expect(doc.textStyles.get(doc.body.styleAt(2)).bold).toBe(true);
    expect(doc.body.paraAt(3)).toEqual({ style: 'heading1', align: 'center' });
    expect(doc.body.paraAt(7)).toEqual({ style: 'heading1', align: 'center' });
    applyOp(doc, inv2);
    applyOp(doc, inv1);
    expect(snapshotKey(doc)).toBe(before);
  });

  it('deletes a table with its cells and brings them back on undo', () => {
    const doc = tableDoc();
    expect(doc.stories.has(cellStoryId('t', 'r3', 'c2'))).toBe(true);
    const before = snapshotKey(doc);
    const inv = applyOp(doc, { type: 'delete', story: BODY, from: 0, to: 2 });
    expect(doc.tables.size).toBe(0);
    expect([...doc.stories.keys()]).toEqual([BODY]);
    applyOp(doc, inv);
    expect(snapshotKey(doc)).toBe(before);
    expect(doc.story(cellStoryId('t', 'r2', 'c2'))!.text()).toBe(`hello${PARA}`);
  });

  it('shrinks and restores merges when rows are deleted and re-inserted', () => {
    const doc = tableDoc();
    const before = snapshotKey(doc);
    const inv = applyOp(doc, { type: 'deleteTableDims', table: 't', axis: 'row', at: 2, count: 1 });
    expect(doc.tables.get('t')!.cells!['r1:c1']).toEqual({ rowSpan: 2 });
    applyOp(doc, inv);
    expect(snapshotKey(doc)).toBe(before);

    const inv2 = applyOp(doc, { type: 'insertTableDims', table: 't', axis: 'row', at: 1, items: [{ id: 'rx' }] });
    expect(doc.tables.get('t')!.cells!['r1:c1']).toEqual({ rowSpan: 4 });
    expect(doc.stories.has(cellStoryId('t', 'rx', 'c2'))).toBe(true);
    applyOp(doc, inv2);
    expect(snapshotKey(doc)).toBe(before);
  });

  it('moves anchors with the text and restores them on undo', () => {
    const doc = docWith('abcdefgh');
    applyOp(doc, { type: 'patchAnchors', set: [{ id: 'c', kind: 'comment', story: BODY, from: 2, to: 6 }] });
    const before = snapshotKey(doc);
    const inv = applyOp(doc, { type: 'delete', story: BODY, from: 1, to: 4 });
    expect(doc.anchors.get('c')).toMatchObject({ from: 1, to: 3 });
    applyOp(doc, inv);
    expect(snapshotKey(doc)).toBe(before);
    applyOp(doc, { type: 'insert', story: BODY, at: 4, content: { text: 'XY' } });
    expect(doc.anchors.get('c')).toMatchObject({ from: 2, to: 8 });
  });

  it('has an exact inverse for every random op', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = rng(seed);
      const makeId = counterIds(`s${seed}_`);
      const doc = DocModel.create();
      for (let step = 0; step < 150; step++) {
        const op = randomOp(doc, random, makeId);
        if (!op) continue;
        expect(isWellFormedOp(JSON.parse(JSON.stringify(op)))).toBe(true);
        const before = snapshotKey(doc);
        const inverse = applyOp(doc, op);
        const after = snapshotKey(doc);
        applyOp(doc, inverse);
        expect(snapshotKey(doc)).toBe(before);
        applyOp(doc, op);
        expect(snapshotKey(doc)).toBe(after);
      }
    }
  });

  it('survives a snapshot round trip', () => {
    const random = rng(99);
    const makeId = counterIds();
    const doc = DocModel.create();
    for (let i = 0; i < 300; i++) {
      const op = randomOp(doc, random, makeId);
      if (op) applyOp(doc, op);
    }
    const copy = DocModel.fromSnapshot(JSON.parse(JSON.stringify(doc.toSnapshot())));
    expect(snapshotKey(copy)).toBe(snapshotKey(doc));
  });
});

describe('validateOp', () => {
  it('keeps the final paragraph mark', () => {
    const doc = docWith('abc');
    expect(validateOp(doc, { type: 'delete', story: BODY, from: 0, to: 4 })).not.toBeNull();
    expect(validateOp(doc, { type: 'insert', story: BODY, at: 4, content: { text: 'x' } })).not.toBeNull();
    expect(validateOp(doc, { type: 'delete', story: BODY, from: 0, to: 3 })).toBeNull();
  });

  it('refuses an object without data, a table without cells data, and reused ids', () => {
    const doc = tableDoc();
    expect(validateOp(doc, { type: 'insert', story: BODY, at: 0, content: { text: OBJECT } })).not.toBeNull();
    expect(validateOp(doc, { type: 'insert', story: BODY, at: 0, content: { text: OBJECT, objects: [[0, { kind: 'table', id: 'u' }]] } })).not.toBeNull();
    expect(
      validateOp(doc, {
        type: 'insert',
        story: BODY,
        at: 0,
        content: { text: OBJECT, objects: [[0, { kind: 'table', id: 't' }]], tables: { t: { rows: [{ id: 'a' }], cols: [{ id: 'b', width: 9 }] } } },
      }),
    ).not.toBeNull();
  });

  it('refuses a split surrogate pair and control characters', () => {
    const doc = docWith('a😀b');
    expect(validateOp(doc, { type: 'insert', story: BODY, at: 2, content: { text: 'x' } })).not.toBeNull();
    expect(validateOp(doc, { type: 'delete', story: BODY, from: 0, to: 2 })).not.toBeNull();
    expect(validateOp(doc, { type: 'insert', story: BODY, at: 0, content: { text: 'a\u0001' } })).not.toBeNull();
  });

  it('checks the ops of a batch in order', () => {
    const doc = docWith('abc');
    const ok: Op = {
      type: 'batch',
      ops: [
        { type: 'insert', story: BODY, at: 3, content: { text: 'defg' } },
        { type: 'delete', story: BODY, from: 5, to: 7 },
      ],
    };
    expect(validateOp(doc, ok)).toBeNull();
    expect(doc.body.text()).toBe(`abc${PARA}`);
  });
});

describe('isWellFormedOp', () => {
  it('rejects unknown keys and wrong types', () => {
    expect(isWellFormedOp({ type: 'insert', story: BODY, at: 0, content: { text: 'a' } })).toBe(true);
    expect(isWellFormedOp({ type: 'insert', story: BODY, at: -1, content: { text: 'a' } })).toBe(false);
    expect(isWellFormedOp({ type: 'formatText', story: BODY, at: 0, runs: [[1, { evil: true }]] })).toBe(false);
    expect(isWellFormedOp({ type: 'formatText', story: BODY, at: 0, runs: [[1, { color: 'red' }]] })).toBe(false);
    expect(isWellFormedOp({ type: 'nope' })).toBe(false);
  });
});

describe('transform', () => {
  it('keeps text typed inside a range someone deletes', () => {
    const doc = docWith('abcdefgh');
    const del: Op = { type: 'delete', story: BODY, from: 2, to: 6 };
    const ins: Op = { type: 'insert', story: BODY, at: 4, content: { text: 'XY' } };
    applyOp(doc, ins);
    applyOp(doc, transform(del, ins, true));
    expect(doc.body.text()).toBe(`abXYgh${PARA}`);
  });

  it('breaks insert ties by who the room applied later', () => {
    const a: Op = { type: 'insert', story: BODY, at: 1, content: { text: 'A' } };
    const b: Op = { type: 'insert', story: BODY, at: 1, content: { text: 'B' } };
    const doc1 = docWith('xy');
    applyOp(doc1, b);
    applyOp(doc1, transform(a, b, true));
    expect(doc1.body.text()).toBe(`xBAy${PARA}`);
  });

  it('does not format text inserted inside the range concurrently', () => {
    const doc = docWith('abcdef');
    const fmt: Op = { type: 'formatText', story: BODY, at: 1, runs: [[4, { bold: true }]] };
    const ins: Op = { type: 'insert', story: BODY, at: 3, content: { text: 'ZZ' } };
    applyOp(doc, ins);
    applyOp(doc, transform(fmt, ins, true));
    const bold = [...doc.body.text()].map((_, i) => (doc.textStyles.get(doc.body.styleAt(i)).bold ? 1 : 0)).join('');
    expect(bold).toBe('01100110' + '0');
  });

  it('keeps rows inserted inside a range of rows being deleted', () => {
    const doc = tableDoc();
    const del: Op = { type: 'deleteTableDims', table: 't', axis: 'row', at: 0, count: 3 };
    const ins: Op = { type: 'insertTableDims', table: 't', axis: 'row', at: 1, items: [{ id: 'new' }] };
    applyOp(doc, ins);
    applyOp(doc, transform(del, ins, true));
    expect(doc.tables.get('t')!.rows.map((r) => r.id)).toEqual(['new']);
  });
});

describe('review fixes', () => {
  it('refuses unsafe link targets in ops from outside', () => {
    expect(isWellFormedOp({ type: 'formatText', story: BODY, at: 0, runs: [[1, { link: 'https://ok.example' }]] })).toBe(true);
    expect(isWellFormedOp({ type: 'formatText', story: BODY, at: 0, runs: [[1, { link: 'javascript:alert(1)' }]] })).toBe(false);
    expect(isWellFormedOp({ type: 'insert', story: BODY, at: 0, content: { text: 'x', runs: [[1, { link: ' data:text/html,x' }]] } })).toBe(false);
  });

  it('refuses a new row whose cell claims a table that already exists', () => {
    const doc = tableDoc();
    const t = doc.tables.get('t')!;
    const cell = cellStoryId('t', 'rNew', t.cols[0]!.id);
    const op: Op = {
      type: 'insertTableDims',
      table: 't',
      axis: 'row',
      at: 0,
      items: [{ id: 'rNew' }],
      content: { stories: { [cell]: { text: `${OBJECT}${PARA}`, objects: [[0, { kind: 'table', id: 't' }]] } } },
    };
    expect(validateOp(doc, op)).not.toBeNull();
    const stray: Op = { type: 'insertTableDims', table: 't', axis: 'row', at: 0, items: [{ id: 'rNew' }], content: { stories: { 'cell:x:y:z': { text: PARA } } } };
    expect(validateOp(doc, stray)).not.toBeNull();
    const ok: Op = { type: 'insertTableDims', table: 't', axis: 'row', at: 0, items: [{ id: 'rNew' }], content: { stories: { [cell]: { text: `hi${PARA}` } } } };
    expect(validateOp(doc, ok)).toBeNull();
  });
});
