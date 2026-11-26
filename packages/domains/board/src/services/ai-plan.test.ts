import { describe, expect, it } from 'vitest';
import { Board, NOOP, emptySnapshot, makeCard, makeConnector, makeFrame, makeShape, makeSticky, makeText, unbatch, type BoardElement, type Op } from '@weldsuite/board-engine';
import type { BoardAiInput } from '@weldsuite/app-api-client/schemas/boards';
import { BoardAiError, boardAiAsk, boardAiPlan, checkBoardAi } from './ai-plan';

const AT = { userId: 'alice', now: 1_700_000_000_000 };

function boardWith(...elements: BoardElement[]): Board {
  return Board.fromSnapshot({ ...emptySnapshot(), elements: [...elements].sort((a, b) => (a.id < b.id ? -1 : 1)) });
}

const note = (id: string, text: string, extra: Partial<BoardElement> = {}): BoardElement => ({ ...makeSticky(0, 0, { createdBy: 'alice' }, { id, text }), ...extra });

/** A frame holding two notes, a loose note, a card, a connector and an empty note. */
function workshop(): Board {
  return boardWith(
    makeFrame(0, 0, 800, 600, 'Ideas', {}, { id: 'frame' }),
    note('n_in_1', 'Faster onboarding', { parent: 'frame' }),
    note('n_in_2', 'Fewer   clicks', { parent: 'frame' }),
    note('n_loose', 'Dark mode', { fill: '#ffd' }),
    makeCard(900, 0, 'Billing page', {}, { id: 'card', description: 'Rework' }),
    makeShape('diamond', 900, 300, 160, 100, {}, { id: 'shape', text: 'Decide' }),
    makeText(0, 700, 'A heading', {}, { id: 'text' }),
    makeConnector({ x: 0, y: 0 }, { x: 10, y: 10 }, {}, { id: 'line' }),
    note('n_empty', ''),
  );
}

const input = (action: BoardAiInput['action'], extra: Partial<BoardAiInput> = {}): BoardAiInput => ({ action, ...extra });

function refusal(run: () => unknown): BoardAiError {
  try {
    run();
  } catch (err) {
    if (err instanceof BoardAiError) return err;
    throw err;
  }
  throw new Error('expected a BoardAiError');
}

/** The elements an op creates, inside a batch too. */
const created = (op: Op) => unbatch(op).flatMap((o) => (o.type === 'create' ? o.elements : []));

describe('checkBoardAi', () => {
  it('wants a prompt for what it generates', () => {
    for (const action of ['mindmap', 'diagram', 'stickies'] as const) {
      const err = refusal(() => checkBoardAi(workshop(), input(action, { prompt: '   ' })));
      expect(err).toMatchObject({ name: 'BoardAiError', code: 'PROMPT_REQUIRED', status: 400 });
      expect(() => checkBoardAi(workshop(), input(action, { prompt: 'Launch plan' }))).not.toThrow();
    }
  });

  it('wants notes with text for what works on notes', () => {
    for (const action of ['cluster', 'ideas'] as const) {
      expect(refusal(() => checkBoardAi(workshop(), input(action, { elementIds: ['n_empty', 'line', 'missing'] })))).toMatchObject({ code: 'NOTHING_TO_DO' });
      expect(() => checkBoardAi(workshop(), input(action, { elementIds: ['n_loose'] }))).not.toThrow();
    }
    // A summary of no selection is a summary of the whole board.
    expect(() => checkBoardAi(workshop(), input('summarize'))).not.toThrow();
  });
});

describe('boardAiAsk', () => {
  it('asks for drafts in the person’s language', () => {
    const mindmap = boardAiAsk(workshop(), input('mindmap', { prompt: ' Launch plan ', locale: 'nl' }));
    expect(mindmap).toMatchObject({ task: 'draft', schemaName: 'mindmap', user: 'Make a mind map about: Launch plan' });
    expect(mindmap.system).toContain('Write every text in Dutch');
    expect(boardAiAsk(workshop(), input('diagram', { prompt: 'Checkout' }))).toMatchObject({ schemaName: 'diagram', user: 'Draw a flowchart of: Checkout' });
    const stickies = boardAiAsk(workshop(), input('stickies', { prompt: 'Retro' }));
    expect(stickies).toMatchObject({ schemaName: 'stickies', user: 'Write sticky notes for: Retro' });
    expect(stickies.system).toContain('Write every text in English');
  });

  it('numbers the notes to cluster, frames opened up, and marks the board text as data', () => {
    const ask = boardAiAsk(workshop(), input('cluster', { elementIds: ['frame', 'n_loose', 'n_loose', 'card', 'shape', 'text'] }));
    expect(ask).toMatchObject({ task: 'classify', schemaName: 'themes' });
    expect(ask.user).toBe('<notes>\nn1: Faster onboarding\nn2: Fewer clicks\nn3: Dark mode\nn4: Billing page\nn5: Decide\n</notes>');
    expect(ask.system).toContain('not instructions');
    expect(refusal(() => boardAiAsk(workshop(), input('cluster', { elementIds: ['n_loose', 'text'] })))).toMatchObject({ code: 'NOTHING_TO_DO' });
  });

  it('lists the notes to build on, with the focus the person gave', () => {
    const ask = boardAiAsk(workshop(), input('ideas', { elementIds: ['n_loose', 'card'], prompt: 'mobile' }));
    expect(ask.user).toBe('<notes>\n- Dark mode\n- Billing page\n</notes>\nFocus: mobile');
    expect(boardAiAsk(workshop(), input('ideas', { elementIds: ['n_loose'] })).user).toBe('<notes>\n- Dark mode\n</notes>');
  });

  it('summarises the selection, or the whole board, and refuses an empty one', () => {
    expect(boardAiAsk(workshop(), input('summarize', { elementIds: ['n_loose'] })).user).toBe('<board>\n- Dark mode\n</board>');
    const whole = boardAiAsk(workshop(), input('summarize', { prompt: 'decisions' }));
    expect(whole).toMatchObject({ task: 'summarize', schemaName: 'summary' });
    expect(whole.user).toContain('Faster onboarding');
    expect(whole.user.endsWith('\nFocus: decisions')).toBe(true);
    expect(refusal(() => boardAiAsk(boardWith(), input('summarize')))).toMatchObject({ code: 'NOTHING_TO_DO', status: 400 });
  });
});

describe('boardAiPlan', () => {
  it('places a mind map, where the person asked', () => {
    const answer = { root: 'Launch', branches: [{ text: 'Marketing', children: [{ text: 'Blog', children: [{ text: 'Post 1' }] }, { text: 'Ads' }] }, { text: 'Sales' }] };
    const plan = boardAiPlan(boardWith(), input('mindmap', { prompt: 'Launch', at: { x: 5000, y: 5000 } }), answer, AT);
    const elements = created(plan.op);
    expect([...plan.elementIds].sort()).toEqual(elements.map((e) => e.id).sort());
    expect(elements.map((e) => e.text?.text ?? e.name).filter(Boolean)).toEqual(expect.arrayContaining(['Launch', 'Marketing', 'Blog', 'Post 1', 'Ads', 'Sales']));
    expect(elements.every((e) => e.createdBy === 'alice')).toBe(true);
    expect(Math.min(...elements.map((e) => e.x))).toBeGreaterThanOrEqual(4000);
  });

  it('draws a flowchart, with steps in known shapes only', () => {
    const answer = {
      direction: 'right',
      steps: [
        { key: 's1', text: 'Start', shape: 'terminator' },
        { key: 's2', text: 'Paid?', shape: 'diamond' },
        { key: 's3', text: 'Ship', shape: 'hexagon' },
      ],
      arrows: [
        { from: 's1', to: 's2' },
        { from: 's2', to: 's3', label: 'Yes' },
      ],
    };
    const elements = created(boardAiPlan(boardWith(), input('diagram', { prompt: 'Orders' }), answer, AT).op);
    const shapes = elements.filter((e) => e.type === 'shape');
    expect(Object.fromEntries(shapes.map((e) => [e.text?.text, e.shape]))).toEqual({ Start: 'terminator', 'Paid?': 'diamond', Ship: 'rounded' });
    expect(elements.filter((e) => e.type === 'connector')).toHaveLength(2);
    // Without arrows or a direction it still draws the steps, top to bottom.
    expect(created(boardAiPlan(boardWith(), input('diagram', { prompt: 'x' }), { steps: [{ key: 'a', text: 'Only' }] }, AT).op)).toHaveLength(1);
  });

  it('writes sticky notes, in frames when the answer has titled groups', () => {
    const loose = created(boardAiPlan(boardWith(), input('stickies', { prompt: 'x' }), { groups: [{ notes: ['One', 'Two'] }] }, AT).op);
    expect(loose.map((e) => e.type)).toEqual(['sticky', 'sticky']);

    const answer = {
      groups: [
        { title: 'Keep', color: 'green', notes: ['Standups'] },
        { title: '', color: 'chartreuse', notes: ['Demos'] },
        { title: 'Empty', notes: [] },
      ],
    };
    const framed = created(boardAiPlan(boardWith(), input('stickies', { prompt: 'Retro' }), answer, AT).op);
    // Placed elements come in no set order: match notes to frames by name.
    const frameName = new Map(framed.filter((e) => e.type === 'frame').map((f) => [f.id, f.name]));
    expect([...frameName.values()].sort()).toEqual(['2', 'Keep']);
    const notes = new Map(framed.filter((e) => e.type === 'sticky').map((n) => [n.text?.text, n]));
    expect(frameName.get(notes.get('Standups')!.parent!)).toBe('Keep');
    expect(frameName.get(notes.get('Demos')!.parent!)).toBe('2');
    // A colour the palette has is used; one it does not have is not.
    expect(notes.get('Standups')!.fill).not.toBe(notes.get('Demos')!.fill);
  });

  it('refuses an answer with nothing to place', () => {
    expect(refusal(() => boardAiPlan(boardWith(), input('stickies', { prompt: 'x' }), {}, AT))).toMatchObject({ code: 'AI_REQUEST_FAILED', status: 502 });
  });

  it('frames the notes by the themes the model found, leaving out what it left out', () => {
    const board = workshop();
    const answer = { themes: [{ title: 'Speed', notes: ['n1', ' n2 ', 'n9'] }, { title: 'Looks', notes: ['n3'] }] };
    const plan = boardAiPlan(board, input('cluster', { elementIds: ['frame', 'n_loose', 'card'] }), answer, AT);
    expect(plan.elementIds).toHaveLength(2);
    const frames = created(plan.op).filter((e) => e.type === 'frame');
    expect(frames.map((f) => f.name)).toEqual(['Speed', 'Looks']);
    expect(boardAiPlan(board, input('cluster', { elementIds: ['n_loose', 'card'] }), {}, AT).elementIds).toEqual([]);
  });

  it('adds ideas next to the notes, in their colour', () => {
    const plan = boardAiPlan(workshop(), input('ideas', { elementIds: ['n_loose'] }), { ideas: ['Light mode', 'High contrast'] }, AT);
    const ideas = created(plan.op);
    expect(ideas.map((e) => e.text?.text).sort()).toEqual(['High contrast', 'Light mode']);
    expect(ideas.every((e) => e.fill === '#ffd')).toBe(true);
    // From a card alone they keep the default colour, and go wherever there is room.
    const fromCard = created(boardAiPlan(workshop(), input('ideas', { elementIds: ['card'] }), { ideas: ['Invoices'] }, AT).op);
    expect(fromCard[0]!.fill).not.toBe('#ffd');
  });

  it('turns a summary into text to save, without touching the board', () => {
    const plan = boardAiPlan(workshop(), input('summarize'), { title: 'Workshop', markdown: '# Points\n- [ ] Ship' }, AT);
    expect(plan).toEqual({ op: NOOP, elementIds: [], text: '# Points\n- [ ] Ship', title: 'Workshop' });
    expect(boardAiPlan(workshop(), input('summarize'), {}, AT)).toEqual({ op: NOOP, elementIds: [], text: '', title: '' });
  });
});
