import { describe, expect, it } from 'vitest';
import { ContentBuilder } from '../model/builder';
import { DocModel } from '../model/document';
import { BODY } from '../model/objects';
import { applyOp } from '../ops/apply';
import type { Op } from '../ops/types';
import { validateOp } from '../ops/validate';
import { pageDisplay } from '../layout/display';
import { DocLayout } from '../layout/document-layout';
import { tableColumnEdges } from '../layout/geometry';
import { MetricsMeasurer } from '../layout/measure';
import { counterIds, snapshotKey } from '../test-support';
import { caretAt, insertText } from './commands';
import { insertSectionBreak, sectionAt, setSectionAt } from './sections';
import { insertTable } from './tables';
import { TOC_PREFIX, insertToc, tocAt, tocHeadings, updateToc } from './toc';

function run(d: DocModel, op: Op): Op {
  expect(validateOp(d, op)).toBeNull();
  return applyOp(d, op);
}

/** Intro, then two headings with a page break between them. */
function headedDoc(): DocModel {
  const d = DocModel.create();
  const b = new ContentBuilder();
  b.addText('Intro').endParagraph();
  b.addText('Getting started').endParagraph({ style: 'heading1' });
  b.addText('Body text').endParagraph();
  b.addObject({ kind: 'pageBreak' }).endParagraph();
  b.addText('Details').endParagraph({ style: 'heading2' });
  b.addText('Deep').endParagraph({ style: 'heading4' });
  applyOp(d, { type: 'insert', story: BODY, at: 0, content: b.build() });
  return d;
}

function layoutOf(d: DocModel): DocLayout {
  const dl = new DocLayout(d, { measurer: new MetricsMeasurer() });
  dl.update();
  return dl;
}

describe('table of contents', () => {
  it('lists headings up to level 3 with links and page numbers', () => {
    const d = headedDoc();
    expect(tocHeadings(d).map((h) => [h.level, h.text])).toEqual([
      [1, 'Getting started'],
      [2, 'Details'],
    ]);
    const before = snapshotKey(d);
    const edit = insertToc(d, caretAt(BODY, 0), 'No headings', counterIds('x'));
    const inverse = run(d, edit.op);

    const toc = [...d.anchors.values()].find((a) => a.id.startsWith(TOC_PREFIX))!;
    expect(d.body.text(toc.from, toc.to)).toBe('Getting started\t￼\nDetails\t￼\n');
    // Each heading now has a bookmark, and the TOC links to it.
    const marks = tocHeadings(d);
    expect(marks.every((h) => h.bookmark)).toBe(true);
    expect(d.textStyles.get(d.body.styleAt(toc.from))?.link).toBe(`#${marks[0]!.bookmark}`);
    expect(tocAt(d, BODY, toc.from + 2)).toBe(toc.id);

    const dl = layoutOf(d);
    const page = dl.pages[0]!;
    const texts = pageDisplay(dl, page).filter((i) => i.kind === 'text').map((i) => (i.kind === 'text' ? i.text : ''));
    // The heading on the second page shows page 2.
    const detailsAt = texts.indexOf('Details');
    expect(texts.slice(detailsAt, detailsAt + 3)).toContain('2');

    applyOp(d, inverse);
    expect(snapshotKey(d)).toBe(before);
  });

  it('rebuilds from the headings as they are now', () => {
    const d = headedDoc();
    run(d, insertToc(d, caretAt(BODY, 0), 'No headings', counterIds('x')).op);
    const toc = [...d.anchors.values()].find((a) => a.id.startsWith(TOC_PREFIX))!;
    // Rename the first heading and add one.
    const at = d.body.text().indexOf('Getting started', toc.to);
    run(d, insertText(d, caretAt(BODY, at), 'Before ').op);
    const end = d.body.length - 1;
    const b = new ContentBuilder().addText('Appendix').endParagraph({ style: 'heading1' }).build();
    run(d, { type: 'insert', story: BODY, at: end, content: b });
    run(d, updateToc(d, toc.id, 'No headings', counterIds('y')));
    const now = d.anchors.get(toc.id)!;
    expect(d.body.text(now.from, now.to)).toBe('Before Getting started\t￼\nDetails\t￼\nAppendix\t￼\n');
    // Bookmarks still sit on their headings.
    for (const h of tocHeadings(d)) {
      const mark = d.anchors.get(h.bookmark!)!;
      expect(h.text).toContain(d.body.text(mark.from, mark.to));
    }
  });

  it('says so when there are no headings', () => {
    const d = DocModel.create();
    run(d, insertToc(d, caretAt(BODY, 0), 'No headings', counterIds('x')).op);
    expect(d.body.text()).toBe('No headings\n\n');
  });

  it('stays out of headers, footers and cells', () => {
    const d = headedDoc();
    const edit = insertToc(d, caretAt('hdr:final:default', 0), 'No headings');
    expect(edit.op.type).toBe('batch');
    expect('ops' in edit.op && edit.op.ops.length).toBe(0);
  });
});

describe('sections', () => {
  it('splits the caret section, copying its layout', () => {
    const d = DocModel.create();
    run(d, insertText(d, caretAt(BODY, 0), 'One Two').op);
    run(d, insertSectionBreak(d, caretAt(BODY, 3), 'nextPage', counterIds('s')).op);
    const first = sectionAt(d, BODY, 0);
    expect(first.breakAt).toBe(3);
    expect(first.props).toEqual(d.props.section);
    // Landscape for the first section only.
    run(d, setSectionAt(d, BODY, 0, { pageWidth: first.props.pageHeight, pageHeight: first.props.pageWidth }));
    const dl = layoutOf(d);
    expect(dl.pages).toHaveLength(2);
    expect(dl.pages[0]!.width).toBeGreaterThan(dl.pages[0]!.height);
    expect(dl.pages[1]!.width).toBeLessThan(dl.pages[1]!.height);
  });

  it('starts a continuous section on the same page', () => {
    const d = DocModel.create();
    run(d, insertText(d, caretAt(BODY, 0), 'One Two').op);
    run(d, insertSectionBreak(d, caretAt(BODY, 3), 'continuous', counterIds('s')).op);
    expect(layoutOf(d).pages).toHaveLength(1);
  });
});

describe('table column edges', () => {
  it('gives the right edge of each column of a placed table', () => {
    const d = DocModel.create();
    run(d, insertTable(d, caretAt(BODY, 0), 2, 3, counterIds('t')).op);
    const dl = layoutOf(d);
    const edges = tableColumnEdges(dl, 0);
    expect(edges.map((e) => e.col)).toEqual([0, 1, 2]);
    expect(edges[0]!.x).toBeLessThan(edges[1]!.x);
    expect(edges[2]!.height).toBeGreaterThan(0);
  });
});
