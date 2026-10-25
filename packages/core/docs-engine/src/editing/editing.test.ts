import { describe, expect, it } from 'vitest';
import { PARA } from '../model/chars';
import { DocModel } from '../model/document';
import { BODY } from '../model/objects';
import { applyOp } from '../ops/apply';
import { validateOp } from '../ops/validate';
import type { Op } from '../ops/types';
import { fromHtml } from '../serialize/html-read';
import { counterIds } from '../test-support';
import { nextGrapheme, nextWord, wordAt } from './boundaries';
import {
  allHave,
  caretAt,
  deleteBackward,
  deleteForward,
  indent,
  insertFragment,
  insertText,
  setLink,
  splitParagraph,
  toggleList,
  type DocSelection,
  type Edit,
} from './commands';
import { findAll, replaceAll, replacementFor, textStats } from './find';

function doc(text: string): DocModel {
  const d = DocModel.create();
  applyOp(d, { type: 'insert', story: BODY, at: 0, content: { text } });
  return d;
}

/** Applies an edit after checking the room would accept it. */
function run(d: DocModel, edit: Edit | Op): DocSelection | null {
  const op = 'op' in edit ? edit.op : edit;
  expect(validateOp(d, op)).toBeNull();
  applyOp(d, op);
  return 'op' in edit ? edit.selection : null;
}

const body = (d: DocModel) => d.body.text();

describe('typing', () => {
  it('types over a selection, keeping the formatting before the caret', () => {
    const d = doc('Hello world');
    applyOp(d, { type: 'formatText', story: BODY, at: 0, runs: [[5, { bold: true }]] });
    const sel = run(d, insertText(d, caretAt(BODY, 5), 'XY'))!;
    expect(body(d)).toBe(`HelloXY world${PARA}`);
    expect(sel.head).toBe(7);
    expect(d.textStyles.get(d.body.styleAt(6)).bold).toBe(true);
    run(d, insertText(d, { story: BODY, anchor: 0, head: 7 }, 'Hi'));
    expect(body(d)).toBe(`Hi world${PARA}`);
  });

  it('does not grow a link past its end', () => {
    const d = doc('see ');
    const sel = run(d, setLink(d, caretAt(BODY, 4), 'https://x.org', 'here'))!;
    run(d, insertText(d, sel, '!'));
    const at = (p: number) => d.textStyles.get(d.body.styleAt(p)).link;
    expect(at(5)).toBe('https://x.org');
    expect(at(8)).toBeUndefined();
  });
});

describe('Enter, Backspace and Delete', () => {
  it('splits a heading and starts normal text after it', () => {
    const d = doc('Title');
    applyOp(d, { type: 'formatParagraphs', story: BODY, at: 5, runs: [[1, { style: 'heading1' }]] });
    const sel = run(d, splitParagraph(d, caretAt(BODY, 5)))!;
    expect(body(d)).toBe(`Title${PARA}${PARA}`);
    expect(d.body.paraAt(5)).toEqual({ style: 'heading1' });
    expect(d.body.paraAt(6)).toEqual({});
    expect(sel.head).toBe(6);
  });

  it('keeps the first paragraph’s formatting when Backspace joins two', () => {
    const d = doc(`Head${PARA}body`);
    applyOp(d, { type: 'formatParagraphs', story: BODY, at: 4, runs: [[1, { style: 'heading2' }]] });
    const sel = run(d, deleteBackward(d, caretAt(BODY, 5)))!;
    expect(body(d)).toBe(`Headbody${PARA}`);
    expect(d.body.paraAt(8)).toEqual({ style: 'heading2' });
    expect(sel.head).toBe(4);
  });

  it('removes a bullet before joining, and ends a list on Enter in an empty item', () => {
    const d = doc(`a${PARA}`);
    run(d, toggleList(d, caretAt(BODY, 2), 'bullet', counterIds('l')));
    expect(d.body.paraAt(2)?.list).toBeDefined();
    run(d, splitParagraph(d, caretAt(BODY, 2)));
    expect(d.body.paraAt(2)?.list).toBeUndefined();
    run(d, toggleList(d, caretAt(BODY, 2), 'bullet', counterIds('m')));
    run(d, deleteBackward(d, caretAt(BODY, 2)));
    expect(d.body.paraAt(2)?.list).toBeUndefined();
    expect(body(d)).toBe(`a${PARA}${PARA}`);
  });

  it('deletes by grapheme and by word', () => {
    const d = doc('one two 👍🏽');
    run(d, deleteBackward(d, caretAt(BODY, d.body.length - 1)));
    expect(body(d)).toBe(`one two ${PARA}`);
    run(d, deleteBackward(d, caretAt(BODY, 7), 'word'));
    expect(body(d)).toBe(`one  ${PARA}`);
    run(d, deleteForward(d, caretAt(BODY, 0), 'word'));
    expect(body(d)).toBe(`  ${PARA}`);
  });

  it('never deletes the final paragraph mark', () => {
    const d = doc('x');
    const e = deleteForward(d, caretAt(BODY, 1));
    expect(e.op).toEqual({ type: 'batch', ops: [] });
  });
});

describe('lists and indents', () => {
  it('continues the list above and indents list items by level', () => {
    const d = doc(`one${PARA}two${PARA}three`);
    run(d, toggleList(d, caretAt(BODY, 0), 'numbered', counterIds('n')));
    run(d, toggleList(d, { story: BODY, anchor: 4, head: 9 }, 'numbered', counterIds('o')));
    const id = d.body.paraAt(3)!.list!.id;
    expect(d.body.paraAt(7)!.list!.id).toBe(id);
    expect(d.body.paraAt(13)!.list!.id).toBe(id);
    run(d, indent(d, caretAt(BODY, 5), 1));
    expect(d.body.paraAt(7)!.list!.level).toBe(1);
    run(d, toggleList(d, { story: BODY, anchor: 0, head: 13 }, 'numbered'));
    expect(d.body.paraAt(3)!.list).toBeUndefined();
  });
});

describe('marks', () => {
  it('reports bold across a selection, through named styles too', () => {
    const d = doc('plain bold');
    applyOp(d, { type: 'formatText', story: BODY, at: 6, runs: [[4, { bold: true }]] });
    expect(allHave(d, { story: BODY, anchor: 6, head: 10 }, 'bold', null)).toBe(true);
    expect(allHave(d, { story: BODY, anchor: 0, head: 10 }, 'bold', null)).toBe(false);
    expect(allHave(d, caretAt(BODY, 2), 'bold', { bold: true })).toBe(true);
  });
});

describe('paste', () => {
  it('pastes a few words inline and whole paragraphs as paragraphs', () => {
    const d = doc('Start end');
    run(d, insertFragment(d, caretAt(BODY, 6), fromHtml('<span>middle</span> '), counterIds('p')));
    expect(body(d)).toBe(`Start middleend${PARA}`);
    run(d, insertFragment(d, caretAt(BODY, 0), fromHtml('<h1>Title</h1><p>Intro</p>'), counterIds('q')));
    expect(body(d)).toBe(`Title${PARA}Intro${PARA}Start middleend${PARA}`);
    expect(d.body.paraAt(5)).toEqual({ style: 'heading1' });
  });

  it('gives a pasted table new ids each time', () => {
    const d = doc('');
    const fragment = fromHtml('<table><tr><td>a</td></tr></table>', { makeId: counterIds('t') });
    run(d, insertFragment(d, caretAt(BODY, 0), fragment, counterIds('a')));
    run(d, insertFragment(d, caretAt(BODY, 0), fragment, counterIds('b')));
    expect(d.tables.size).toBe(2);
  });
});

describe('find and replace', () => {
  it('finds whole words without crossing paragraphs, and replaces them all', () => {
    const d = doc(`cat catalog Cat${PARA}cat`);
    expect(findAll(d, 'cat').length).toBe(4);
    expect(findAll(d, 'cat', { wholeWord: true }).length).toBe(3);
    expect(findAll(d, 'cat', { wholeWord: true, matchCase: true }).length).toBe(2);
    const { op, count } = replaceAll(d, 'cat', 'dog', { wholeWord: true });
    applyOp(d, op);
    expect(count).toBe(3);
    expect(body(d)).toBe(`dog catalog dog${PARA}dog${PARA}`);
  });

  it('counts words and characters', () => {
    expect(textStats(`Hello, world! It's 2026.${PARA}Second line${PARA}`)).toEqual({ words: 6, characters: 35, charactersNoSpaces: 31, paragraphs: 2 });
  });
});

describe('boundaries', () => {
  it('moves by graphemes and words', () => {
    const d = doc('a👍🏽 é-b word');
    const s = d.body;
    expect(nextGrapheme(s, 1, 1)).toBe(5);
    expect(nextGrapheme(s, 5, -1)).toBe(1);
    expect(nextWord(s, 0, 1)).toBe(1);
    expect(wordAt(s, 11)).toEqual({ from: 10, to: 14 });
  });
});

describe('regex replace', () => {
  it('expands groups and keeps lookarounds working, for one match and for all', () => {
    const d = doc('jan@old and 100 EUR');
    const groups = replaceAll(d, String.raw`(\w+)@old`, '$1@new', { regex: true });
    applyOp(d, groups.op);
    expect(d.body.text()).toBe(`jan@new and 100 EUR${PARA}`);
    const look = replaceAll(d, String.raw`\d+(?= EUR)`, 'X', { regex: true });
    expect(look.count).toBe(1);
    applyOp(d, look.op);
    expect(d.body.text()).toBe(`jan@new and X EUR${PARA}`);
    const [m] = findAll(d, '(?<name>jan)@new', { regex: true });
    expect(replacementFor(d, '(?<name>jan)@new', { regex: true }, m!, '$<name>!$$')).toBe('jan!$');
  });
});
