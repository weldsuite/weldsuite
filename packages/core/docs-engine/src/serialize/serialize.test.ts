import { describe, expect, it } from 'vitest';
import { ContentBuilder, type Fragment } from '../model/builder';
import { LINE_BREAK, OBJECT, PARA } from '../model/chars';
import type { Content } from '../model/content';
import { BUILT_IN_STYLES, numberedList } from '../model/defaults';
import { DocModel } from '../model/document';
import { BODY, cellStoryId } from '../model/objects';
import { applyOp } from '../ops/apply';
import { validateContent } from '../ops/validate';
import { counterIds } from '../test-support';
import { toBlocks } from './blocks';
import { fromHtml } from './html-read';
import { toHtml } from './html-write';
import { fromMarkdown } from './markdown-read';
import { toMarkdown } from './markdown-write';
import { toPlainText } from './text';

/** Paragraph texts and their named styles, for compact assertions. */
function paragraphs(content: Content): [string, string][] {
  return toBlocks(content).blocks.map((b) =>
    b.type === 'paragraph' ? [b.inlines.map((i) => (i.type === 'text' ? i.text : i.type === 'break' ? '↵' : i.type === 'object' ? `[${i.data.kind}]` : '→')).join(''), b.props.style ?? 'normal'] : ['[table]', 'table'],
  );
}

function sample(): Fragment {
  const b = new ContentBuilder(counterIds('t'));
  b.addText('Report').endParagraph({ style: 'heading1' });
  b.addText('Hello ').addText('bold', { bold: true }).addText(' and ').addText('link', { link: 'https://weldsuite.org' }).endParagraph();
  b.addText('First').endParagraph({ list: { id: 'n', level: 0 } });
  b.addText('Nested').endParagraph({ list: { id: 'n', level: 1 } });
  b.addText('Second').endParagraph({ list: { id: 'n', level: 0 } });
  const cell = (text: string) => ({ content: { text: `${text}${PARA}` } });
  b.addTable([
    [cell('A'), cell('B')],
    [cell('1'), cell('2')],
  ]);
  b.endParagraph();
  return { content: b.build(), lists: { n: numberedList() } };
}

describe('plain text', () => {
  it('writes list markers and tables as tab-separated rows', () => {
    expect(toPlainText(sample())).toBe('Report\nHello bold and link\n1. First\n  a. Nested\n2. Second\nA\tB\n1\t2');
  });
});

describe('HTML', () => {
  it('writes headings, inline formatting, nested lists and tables', () => {
    const html = toHtml(sample());
    expect(html).toContain('<h1>Report</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://weldsuite.org">link</a>');
    expect(html).toContain('<ol><li>First<ol type="a"><li>Nested</li></ol></li><li>Second</li></ol>');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });

  it('reads back what it writes', () => {
    const back = fromHtml(toHtml(sample()), { makeId: counterIds('r') });
    expect(validateContent(DocModel.create(), back.content)).toBeNull();
    expect(paragraphs(back.content)).toEqual([
      ['Report', 'heading1'],
      ['Hello bold and link', 'normal'],
      ['First', 'normal'],
      ['Nested', 'normal'],
      ['Second', 'normal'],
      ['[table]', 'table'],
    ]);
    const lists = toBlocks(back.content).blocks.filter((b) => b.type === 'paragraph' && b.props.list).map((b) => (b.type === 'paragraph' ? b.props.list!.level : -1));
    expect(lists).toEqual([0, 1, 0]);
    expect(toPlainText(back)).toBe(toPlainText(sample()));
  });

  it('reads a Google Docs paste without leaving its default formatting behind', () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><h2 dir="ltr" style="line-height:1.38;margin-top:18pt;margin-bottom:6pt;"><span style="font-size:16pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;">Plan</span></h2>' +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;">Bold</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;"> and plain</span></p>' +
      '<ul style="margin-top:0;margin-bottom:0;"><li dir="ltr" style="list-style-type:disc;font-size:11pt;"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation"><span style="font-size:11pt;">Item</span></p></li></ul></b>';
    const { content, lists } = fromHtml(html, { makeId: counterIds('g') });
    expect(paragraphs(content)).toEqual([
      ['Plan', 'heading2'],
      ['Bold and plain', 'normal'],
      ['Item', 'normal'],
    ]);
    // Only the bold survives as direct formatting.
    expect(content.runs).toEqual([
      [5, {}],
      [4, { bold: true }],
    ]);
    const item = toBlocks(content).blocks[2];
    expect(item?.type === 'paragraph' && item.props.list?.level).toBe(0);
    expect(Object.values(lists ?? {})[0]?.levels[0]?.format).toBe('bullet');
  });

  it('reads Word lists from mso-list and drops the marker text', () => {
    const html =
      '<p class=MsoListParagraphCxSpFirst style="text-indent:-18.0pt;mso-list:l0 level1 lfo1"><![if !supportLists]><span>1.<span>&nbsp;&nbsp; </span></span><![endif]>Apples<o:p></o:p></p>' +
      '<p class=MsoListParagraphCxSpLast style="text-indent:-18.0pt;mso-list:l0 level2 lfo1"><!--[if !supportLists]--><span>a.<span>&nbsp; </span></span><!--[endif]-->Pears<o:p></o:p></p>' +
      '<p class=MsoNormal><o:p>&nbsp;</o:p></p>';
    const { content, lists } = fromHtml(html, { makeId: counterIds('w') });
    expect(paragraphs(content)).toEqual([
      ['Apples', 'normal'],
      ['Pears', 'normal'],
      ['', 'normal'],
    ]);
    const def = Object.values(lists ?? {})[0]!;
    expect(def.levels[0]!.format).toBe('decimal');
    expect(def.levels[1]!.format).toBe('lowerAlpha');
  });

  it('places table cells with row and column spans on a grid', () => {
    const html = '<table><tr><td rowspan="2">A</td><td>B</td><td>C</td></tr><tr><td colspan="2">D</td></tr></table>';
    const { content } = fromHtml(html, { makeId: counterIds('x') });
    expect(validateContent(DocModel.create(), content)).toBeNull();
    const table = Object.values(content.tables!)[0]!;
    expect(table.rows).toHaveLength(2);
    expect(table.cols).toHaveLength(3);
    const tableId = Object.keys(content.tables!)[0]!;
    const d = content.stories![cellStoryId(tableId, table.rows[1]!.id, table.cols[1]!.id)];
    expect(d?.text).toBe(`D${PARA}`);
    expect(Object.values(table.cells!)).toEqual([{ rowSpan: 2 }, { colSpan: 2 }]);
  });

  it('keeps unsafe links and scripts out', () => {
    const { content } = fromHtml('<p><a href="javascript:alert(1)">x</a><script>alert(2)</script><img src="javascript:x"></p>');
    expect(content.text).toBe(`x${PARA}`);
    expect(content.runs).toBeUndefined();
  });

  it('turns <br> into line breaks and keeps an empty paragraph made of <br>', () => {
    const { content } = fromHtml('<p>one<br>two</p><p><br></p><p>three</p>');
    expect(content.text).toBe(`one${LINE_BREAK}two${PARA}${PARA}three${PARA}`);
  });

  it('inserts into a document', () => {
    const doc = DocModel.create();
    const { content, lists } = fromHtml(toHtml(sample()), { makeId: counterIds('i') });
    applyOp(doc, { type: 'patchLists', set: lists });
    applyOp(doc, { type: 'insert', story: BODY, at: 0, content });
    expect(doc.tables.size).toBe(1);
    expect(doc.body.text().startsWith('Report')).toBe(true);
    expect(doc.body.text().includes(OBJECT)).toBe(true);
  });
});

describe('Markdown', () => {
  it('reads blocks and inlines', () => {
    const md = [
      '# Title',
      '',
      'Some *em*, **strong**, ***both***, ~~gone~~, `code` and [a link](https://x.org "t").',
      '',
      '- one',
      '- two',
      '  1. sub',
      '- [x] done',
      '',
      '> quoted',
      '',
      '```js',
      'let a = 1;',
      '```',
      '',
      '| A | B |',
      '|---|--:|',
      '| 1 | 2 |',
      '',
      '---',
    ].join('\n');
    const { content } = fromMarkdown(md, { makeId: counterIds('m') });
    expect(validateContent(DocModel.create(), content)).toBeNull();
    expect(paragraphs(content)).toEqual([
      ['Title', 'heading1'],
      ['Some em, strong, both, gone, code and a link.', 'normal'],
      ['one', 'normal'],
      ['two', 'normal'],
      ['sub', 'normal'],
      ['done', 'normal'],
      ['quoted', 'quote'],
      ['let a = 1;', 'code'],
      ['[table]', 'table'],
      ['[hr]', 'normal'],
    ]);
    const runs = content.runs!.map(([len, s]) => [content.text.slice(0, 0).length + len, s]);
    expect(runs.some(([, s]) => (s as { bold?: boolean; italic?: boolean }).bold && (s as { italic?: boolean }).italic)).toBe(true);
    expect(runs.some(([, s]) => (s as { strike?: boolean }).strike)).toBe(true);
    expect(runs.some(([, s]) => (s as { link?: string }).link === 'https://x.org')).toBe(true);
  });

  it('round-trips through the writer', () => {
    const md = toMarkdown(sample());
    expect(md).toBe('# Report\n\nHello **bold** and [link](https://weldsuite.org)\n\n1. First\n    1. Nested\n2. Second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    const back = fromMarkdown(md, { makeId: counterIds('b') });
    expect(toPlainText(back).replace(/a\. Nested/, '1. Nested')).toBe(toPlainText(sample()).replace(/a\. Nested/, '1. Nested'));
  });

  it('escapes text that would read as Markdown', () => {
    const b = new ContentBuilder();
    b.addText('# not a heading *nor emphasis*').endParagraph();
    expect(toMarkdown({ content: b.build(), styles: BUILT_IN_STYLES })).toBe('\\# not a heading \\*nor emphasis\\*\n');
  });
});
