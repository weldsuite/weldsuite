import { describe, expect, it } from 'vitest';
import { BODY, MetricsMeasurer, PARA, caretAt, cellOf } from '@weldsuite/docs-engine';
import { DocController } from './doc-controller';
import { insertTableAtCaret, runTableAction, tableContext } from './table-actions';

function withTable() {
  const ctl = new DocController(null, { measurer: new MetricsMeasurer() });
  ctl.type('Above');
  ctl.enter();
  insertTableAtCaret(ctl, 2, 2);
  return ctl;
}

const cell = (ctl: DocController) => {
  const c = cellOf(ctl.doc, ctl.selection.story);
  return c ? [c.row, c.col] : null;
};

describe('tables in the editor', () => {
  it('puts the caret in the first cell of a new table', () => {
    const ctl = withTable();
    expect(cell(ctl)).toEqual([0, 0]);
    expect(tableContext(ctl)).toMatchObject({ rows: 2, cols: 2, headerRows: 0 });
  });

  it('moves through cells with Tab and adds a row after the last', () => {
    const ctl = withTable();
    ctl.type('a');
    ctl.tab(false);
    expect(cell(ctl)).toEqual([0, 1]);
    ctl.tab(false);
    ctl.tab(false);
    expect(cell(ctl)).toEqual([1, 1]);
    ctl.tab(true);
    expect(cell(ctl)).toEqual([1, 0]);
    ctl.tab(false);
    ctl.tab(false);
    expect(tableContext(ctl)?.rows).toBe(3);
    expect(cell(ctl)).toEqual([2, 0]);
    // Tab selects the next cell's text, as in Google Docs.
    ctl.setSelection(caretAt(ctl.selection.story, 0));
    ctl.tab(true);
    ctl.tab(true);
    ctl.tab(true);
    ctl.tab(true);
    expect(cell(ctl)).toEqual([0, 0]);
    expect(ctl.selection.anchor).toBe(0);
    expect(ctl.selection.head).toBe(1);
  });

  it('moves into and out of a table with Up and Down', () => {
    const ctl = withTable();
    ctl.setSelection(caretAt(BODY, 0));
    ctl.move(1, 'line', false);
    expect(cell(ctl)).toEqual([0, 0]);
    ctl.move(1, 'line', false);
    expect(cell(ctl)).toEqual([1, 0]);
    ctl.move(1, 'line', false);
    expect(ctl.selection.story).toBe(BODY);
    ctl.move(-1, 'line', false);
    expect(cell(ctl)).toEqual([1, 0]);
  });

  it('adds and deletes rows and columns, keeping the caret in the table', () => {
    const ctl = withTable();
    runTableAction(ctl, 'rowBelow');
    expect(cell(ctl)).toEqual([1, 0]);
    expect(tableContext(ctl)?.rows).toBe(3);
    runTableAction(ctl, 'colRight');
    expect(tableContext(ctl)?.cols).toBe(3);
    runTableAction(ctl, 'deleteRow');
    expect(tableContext(ctl)?.rows).toBe(2);
    runTableAction(ctl, 'deleteTable');
    expect(ctl.selection.story).toBe(BODY);
    expect(ctl.doc.tables.size).toBe(0);
    expect(ctl.doc.body.text()).toBe(`Above${PARA}${PARA}`);
  });
});

describe('table of contents in the editor', () => {
  it('inserts, follows its links and updates', () => {
    const ctl = new DocController(null, { measurer: new MetricsMeasurer() });
    ctl.enter();
    ctl.type('Intro');
    ctl.setParagraphStyle('heading1');
    ctl.setSelection(caretAt(BODY, 0));
    ctl.insertToc('None');
    expect(ctl.hasToc).toBe(true);
    expect(ctl.doc.body.text()).toContain(`Intro\t\ufffc${PARA}`);
    const link = ctl.doc.textStyles.get(ctl.doc.body.styleAt(0))?.link ?? '';
    expect(ctl.goToAnchor(link.slice(1))).toBe(true);
    expect(ctl.doc.body.text(ctl.selection.head, ctl.selection.head + 5)).toBe('Intro');
    ctl.type('New ');
    ctl.updateTocs('None');
    expect(ctl.doc.body.text()).toContain(`New Intro\t\ufffc${PARA}`);
  });
});
