import { describe, expect, it } from 'vitest';
import { BODY, MetricsMeasurer, PARA, caretAt } from '@weldsuite/docs-engine';
import { DocController } from './doc-controller';

function make() {
  return new DocController(null, { measurer: new MetricsMeasurer(), reviewer: { id: 'u1', name: 'Ann' } });
}

const kinds = (ctl: DocController) =>
  ctl.doc.body
    .text()
    .split('')
    .map((_, i) => ctl.doc.textStyles.get(ctl.doc.body.styleAt(i)).suggestion?.kind?.[0] ?? '.')
    .join('');

describe('suggesting mode', () => {
  it('turns typing, deleting, Enter and paste into suggestions, accepted or rejected from the editor', () => {
    const ctl = make();
    ctl.type('Hello');
    ctl.setEditMode('suggesting');
    ctl.type(' you');
    ctl.backspace();
    expect(ctl.doc.body.text()).toBe(`Hello yo${PARA}`);
    ctl.setSelection(caretAt(BODY, 5));
    ctl.backspace();
    ctl.enter();
    ctl.paste({ text: 'X' });
    // Hell, the new paragraph mark and X suggested, o struck out, the earlier ' yo' still suggested.
    expect(ctl.doc.body.text()).toBe(`Hell${PARA}Xo yo${PARA}`);
    expect(kinds(ctl)).toBe('....iidiii.');
    expect(ctl.hasSuggestions).toBe(true);
    ctl.resolveAllSuggestions(false);
    expect(ctl.doc.body.text()).toBe(`Hello${PARA}`);
    expect(ctl.hasSuggestions).toBe(false);
  });

  it('makes no edits in viewing mode', () => {
    const ctl = make();
    ctl.type('Hi');
    ctl.setEditMode('viewing');
    expect(ctl.readOnly).toBe(true);
    ctl.type('!');
    expect(ctl.doc.body.text()).toBe(`Hi${PARA}`);
    expect(ctl.mayEdit).toBe(true);
  });
});

describe('comments', () => {
  it('lets a commenter comment and reply without editing', () => {
    const ctl = make();
    ctl.type('Hello world');
    ctl.setReadOnly(true);
    ctl.canComment = true;
    ctl.setSelection({ story: BODY, anchor: 6, head: 11 });
    ctl.startComment();
    const thread = ctl.addComment({ body: 'Which world?', mentions: ['u2'] })!;
    ctl.reply(thread, { body: 'This one' });
    ctl.type('!');
    expect(ctl.doc.body.text()).toBe(`Hello world${PARA}`);
    const [t] = ctl.threads();
    expect(t!.root).toMatchObject({ body: 'Which world?', quote: 'world', author: { id: 'u1', name: 'Ann' } });
    expect(t!.replies.map((r) => r.body)).toEqual(['This one']);
    ctl.setResolved(thread, true);
    expect(ctl.threads()[0]!.root.resolved).toBe(true);
  });

  it('keeps a viewer without comment rights out', () => {
    const ctl = make();
    ctl.type('Hi');
    ctl.setReadOnly(true);
    ctl.canComment = false;
    ctl.startComment();
    expect(ctl.draft).toBeNull();
  });
});
