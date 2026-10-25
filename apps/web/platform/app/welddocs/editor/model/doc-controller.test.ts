import { describe, expect, it, vi } from 'vitest';
import { BODY, MetricsMeasurer, PARA, caretAt } from '@weldsuite/docs-engine';
import { copyFragment, readClipboard, textFragment } from './clipboard';
import { DocController } from './doc-controller';

function make() {
  const onOp = vi.fn();
  const ctl = new DocController(null, { onOp, measurer: new MetricsMeasurer() });
  return { ctl, onOp };
}

const text = (ctl: DocController) => ctl.doc.body.text();

describe('DocController', () => {
  it('types, and undoes a run of typing in one step', () => {
    const { ctl, onOp } = make();
    for (const ch of 'Hello') ctl.type(ch);
    expect(text(ctl)).toBe(`Hello${PARA}`);
    expect(ctl.selection.head).toBe(5);
    expect(onOp).toHaveBeenCalledTimes(5);
    ctl.undo();
    expect(text(ctl)).toBe(PARA);
    ctl.redo();
    expect(text(ctl)).toBe(`Hello${PARA}`);
  });

  it('applies a toggled style to what is typed next', () => {
    const { ctl } = make();
    ctl.type('a');
    ctl.toggle('bold');
    expect(ctl.isActive('bold')).toBe(true);
    ctl.type('b');
    const style = (p: number) => ctl.doc.textStyles.get(ctl.doc.body.styleAt(p));
    expect(style(0).bold).toBeUndefined();
    expect(style(1).bold).toBe(true);
  });

  it('splits paragraphs, makes lists and indents them with Tab', () => {
    const { ctl } = make();
    ctl.type('one');
    ctl.enter();
    ctl.type('two');
    ctl.toggleList('bullet');
    ctl.setSelection(caretAt(BODY, 4));
    ctl.tab(false);
    expect(ctl.doc.body.paraAt(7)?.list?.level).toBe(1);
    ctl.tab(true);
    expect(ctl.doc.body.paraAt(7)?.list?.level).toBe(0);
  });

  it('moves by words and to the document edges, and extends the selection', () => {
    const { ctl } = make();
    ctl.type('alpha beta gamma');
    ctl.move(-1, 'document', false);
    ctl.move(1, 'word', false);
    expect(ctl.selection.head).toBe(5);
    ctl.move(1, 'word', true);
    expect(ctl.selection).toEqual({ story: BODY, anchor: 5, head: 10 });
    ctl.move(1, 'char', false);
    expect(ctl.selection.head).toBe(10);
  });

  it('moves up and down between lines', () => {
    const { ctl } = make();
    ctl.type('first line');
    ctl.enter();
    ctl.type('second line');
    ctl.move(-1, 'line', false);
    expect(ctl.selection.head).toBeLessThan(11);
    ctl.move(1, 'line', false);
    expect(ctl.selection.head).toBeGreaterThan(11);
  });

  it('finds and replaces', () => {
    const { ctl } = make();
    ctl.type('cat and cat');
    ctl.setFind('cat', {});
    expect(ctl.find?.matches).toHaveLength(2);
    expect(ctl.replaceAll('dog')).toBe(2);
    expect(text(ctl)).toBe(`dog and dog${PARA}`);
  });

  it('copies and pastes its own fragments without loss, and plain text into the paragraph', () => {
    const { ctl } = make();
    ctl.type('Title');
    ctl.setParagraphStyle('heading1');
    ctl.enter();
    ctl.type('body');
    const payload = copyFragment(ctl.doc, BODY, 0, ctl.doc.body.length - 1);
    expect(payload.text).toBe('Title\nbody');
    expect(payload.html).toContain('<h1 style="font-size:20pt">Title</h1>');
    const other = make().ctl;
    other.paste({ json: payload.json });
    expect(other.doc.body.paraAt(5)).toEqual({ style: 'heading1' });
    // The fragment also comes back from the HTML comment when the custom type is lost.
    expect(readClipboard({ html: payload.html }, false)?.content.text).toBe(`Title${PARA}body`);
    other.setSelection(caretAt(BODY, 2));
    other.paste({ text: 'XY' });
    expect(other.doc.body.text().startsWith('TiXYtle')).toBe(true);
    expect(textFragment('a\r\nb').content.text).toBe(`a${PARA}b`);
  });

  it('keeps edits out of a read-only document', () => {
    const { ctl, onOp } = make();
    ctl.setReadOnly(true);
    ctl.type('x');
    expect(text(ctl)).toBe(PARA);
    expect(onOp).not.toHaveBeenCalled();
  });

  it('lists headings in the outline', () => {
    const { ctl } = make();
    ctl.type('Intro');
    ctl.setParagraphStyle('heading1');
    ctl.enter();
    ctl.type('text');
    ctl.enter();
    ctl.type('Details');
    ctl.setParagraphStyle('heading2');
    expect(ctl.outline()).toEqual([
      { level: 1, text: 'Intro', pos: 0 },
      { level: 2, text: 'Details', pos: 11 },
    ]);
  });
});
