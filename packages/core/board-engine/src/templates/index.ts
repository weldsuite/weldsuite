/**
 * Built-in templates, as fragments built on demand. Every label a template
 * puts on the board comes through `label(key, english)`, so the platform
 * fills them from its translations; the English text is the fallback.
 */

import { makeCard, makeConnector, makeFrame, makeShape, makeSticky, makeText, STICKY_COLORS } from '../model/defaults';
import { keysBetween } from '../model/order';
import type { BoardElement } from '../model/types';
import type { Fragment } from '../serialize/fragment';

export type TemplateCategory = 'meetings' | 'ideation' | 'planning' | 'strategy' | 'diagramming';

export interface TemplateContext {
  makeId: () => string;
  label: (key: string, english: string) => string;
}

export interface BuiltInTemplate {
  id: string;
  category: TemplateCategory;
  /** Approximate size, for the gallery preview. */
  build: (ctx: TemplateContext) => Fragment;
}

function fragment(elements: BoardElement[]): Fragment {
  // Parents first; then stacking order follows the list.
  const keys = keysBetween(null, null, elements.length || 1);
  const frames = elements.filter((e) => e.type === 'frame');
  const rest = elements.filter((e) => e.type !== 'frame');
  const ordered = [...frames, ...rest];
  ordered.forEach((e, i) => (e.order = keys[i]!));
  let w = 0;
  let h = 0;
  for (const e of ordered) {
    w = Math.max(w, e.x + e.w);
    h = Math.max(h, e.y + e.h);
  }
  return { kind: 'weldboard-fragment', version: 1, elements: ordered, width: w, height: h };
}

function columns(ctx: TemplateContext, titles: [string, string][], options: { width?: number; height?: number; stickies?: number; color?: (i: number) => string }): BoardElement[] {
  const width = options.width ?? 520;
  const height = options.height ?? 760;
  const gap = 40;
  const out: BoardElement[] = [];
  titles.forEach(([key, english], i) => {
    const frame = makeFrame(i * (width + gap), 0, width, height, ctx.label(key, english), {}, { id: ctx.makeId() });
    out.push(frame);
    for (let s = 0; s < (options.stickies ?? 2); s++) {
      out.push(
        makeSticky(frame.x + 40 + (s % 2) * 230, 40 + Math.floor(s / 2) * 230, { parent: frame.id }, { id: ctx.makeId(), color: options.color?.(i) ?? STICKY_COLORS[0], size: 200 }),
      );
    }
  });
  return out;
}

const retrospective: BuiltInTemplate = {
  id: 'retrospective',
  category: 'meetings',
  build: (ctx) =>
    fragment(
      columns(
        ctx,
        [
          ['retro.wentWell', 'What went well'],
          ['retro.toImprove', 'What could be better'],
          ['retro.actions', 'Action items'],
        ],
        { color: (i) => [STICKY_COLORS[3], STICKY_COLORS[8], STICKY_COLORS[5]][i]! },
      ),
    ),
};

const kanban: BuiltInTemplate = {
  id: 'kanban',
  category: 'planning',
  build: (ctx) => {
    const cols: [string, string][] = [
      ['kanban.todo', 'To do'],
      ['kanban.doing', 'In progress'],
      ['kanban.done', 'Done'],
    ];
    const out: BoardElement[] = [];
    cols.forEach(([key, english], i) => {
      const frame = makeFrame(i * 380, 0, 340, 720, ctx.label(key, english), {}, { id: ctx.makeId() });
      out.push(frame);
      for (let c = 0; c < 2; c++) out.push(makeCard(frame.x + 20, 20 + c * 160, ctx.label('kanban.card', 'Card'), { parent: frame.id }, { id: ctx.makeId() }));
    });
    return fragment(out);
  },
};

const swot: BuiltInTemplate = {
  id: 'swot',
  category: 'strategy',
  build: (ctx) => {
    const cells: [string, string, string][] = [
      ['swot.strengths', 'Strengths', STICKY_COLORS[3]],
      ['swot.weaknesses', 'Weaknesses', STICKY_COLORS[12]],
      ['swot.opportunities', 'Opportunities', STICKY_COLORS[5]],
      ['swot.threats', 'Threats', STICKY_COLORS[10]],
    ];
    const out: BoardElement[] = [];
    cells.forEach(([key, english, color], i) => {
      const x = (i % 2) * 620;
      const y = Math.floor(i / 2) * 520;
      const frame = makeFrame(x, y, 580, 480, ctx.label(key, english), {}, { id: ctx.makeId() });
      out.push(frame, makeSticky(x + 40, y + 40, { parent: frame.id }, { id: ctx.makeId(), color }));
    });
    return fragment(out);
  },
};

const leanCanvas: BuiltInTemplate = {
  id: 'lean-canvas',
  category: 'strategy',
  build: (ctx) => {
    const W = 300;
    const H = 300;
    const g = 20;
    const blocks: [string, string, number, number, number, number][] = [
      ['lean.problem', 'Problem', 0, 0, 1, 2],
      ['lean.solution', 'Solution', 1, 0, 1, 1],
      ['lean.metrics', 'Key metrics', 1, 1, 1, 1],
      ['lean.uvp', 'Unique value proposition', 2, 0, 1, 2],
      ['lean.advantage', 'Unfair advantage', 3, 0, 1, 1],
      ['lean.channels', 'Channels', 3, 1, 1, 1],
      ['lean.segments', 'Customer segments', 4, 0, 1, 2],
      ['lean.costs', 'Cost structure', 0, 2, 2.5, 1],
      ['lean.revenue', 'Revenue streams', 2.5, 2, 2.5, 1],
    ];
    return fragment(
      blocks.map(([key, english, cx, cy, cw, ch]) =>
        makeFrame(cx * (W + g), cy * (H + g), cw * W + (cw - 1) * g, ch * H + (ch - 1) * g, ctx.label(key, english), {}, { id: ctx.makeId() }),
      ),
    );
  },
};

const brainstorm: BuiltInTemplate = {
  id: 'brainstorm',
  category: 'ideation',
  build: (ctx) => {
    const out: BoardElement[] = [
      makeShape('ellipse', 380, 300, 280, 160, {}, { id: ctx.makeId(), fill: '#dbeafe', text: ctx.label('brainstorm.topic', 'Our topic') }),
    ];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      out.push(makeSticky(520 + Math.cos(a) * 420 - 100, 380 + Math.sin(a) * 320 - 100, {}, { id: ctx.makeId(), color: STICKY_COLORS[i % 6] }));
    }
    return fragment(out);
  },
};

const flowchart: BuiltInTemplate = {
  id: 'flowchart',
  category: 'diagramming',
  build: (ctx) => {
    const start = makeShape('terminator', 0, 0, 200, 70, {}, { id: ctx.makeId(), fill: '#dcfce7', text: ctx.label('flow.start', 'Start') });
    const step = makeShape('rectangle', 0, 150, 200, 90, {}, { id: ctx.makeId(), text: ctx.label('flow.step', 'Step') });
    const decision = makeShape('diamond', 0, 320, 200, 140, {}, { id: ctx.makeId(), fill: '#fef9c3', text: ctx.label('flow.decision', 'Decision?') });
    const yes = makeShape('rectangle', -280, 540, 200, 90, {}, { id: ctx.makeId(), text: ctx.label('flow.yes', 'Yes') });
    const no = makeShape('rectangle', 280, 540, 200, 90, {}, { id: ctx.makeId(), text: ctx.label('flow.no', 'No') });
    const end = makeShape('terminator', 0, 720, 200, 70, {}, { id: ctx.makeId(), fill: '#fee2e2', text: ctx.label('flow.end', 'End') });
    const link = (a: BoardElement, b: BoardElement, as: 'bottom' | 'left' | 'right', bs: 'top' | 'left' | 'right') =>
      makeConnector({ x: a.x, y: a.y, el: a.id, side: as }, { x: b.x, y: b.y, el: b.id, side: bs }, {}, { id: ctx.makeId(), route: 'elbow' });
    return fragment([
      link(start, step, 'bottom', 'top'),
      link(step, decision, 'bottom', 'top'),
      link(decision, yes, 'left', 'top'),
      link(decision, no, 'right', 'top'),
      link(yes, end, 'bottom', 'left'),
      link(no, end, 'bottom', 'right'),
      start, step, decision, yes, no, end,
    ]);
  },
};

const mindMap: BuiltInTemplate = {
  id: 'mind-map',
  category: 'ideation',
  build: (ctx) => {
    const rootId = ctx.makeId();
    const root = makeShape('rounded', 400, 260, 220, 80, {}, { id: rootId, fill: '#ede9fe', text: ctx.label('mind.root', 'Central idea') });
    root.mindmap = { root: rootId };
    const out: BoardElement[] = [];
    const sides: ('left' | 'right')[] = ['right', 'right', 'left', 'left'];
    sides.forEach((side, i) => {
      const y = 140 + (i % 2) * 220;
      const x = side === 'right' ? 700 : 120;
      const node = makeShape('rounded', x, y, 180, 56, {}, { id: ctx.makeId(), text: ctx.label('mind.branch', 'Branch') });
      node.mindmap = { root: rootId, parent: rootId, side };
      const line = makeConnector(
        { x: 0, y: 0, el: rootId, side: side === 'right' ? 'right' : 'left' },
        { x: 0, y: 0, el: node.id, side: side === 'right' ? 'left' : 'right' },
        {},
        { id: ctx.makeId(), route: 'curved', endCap: 'none' },
      );
      line.stroke = '#94a3b8';
      out.push(line, node);
    });
    return fragment([...out, root]);
  },
};

const userStoryMap: BuiltInTemplate = {
  id: 'user-story-map',
  category: 'planning',
  build: (ctx) => {
    const out: BoardElement[] = [
      makeText(0, 0, ctx.label('story.activities', 'Activities'), {}, { id: ctx.makeId(), fontSize: 20, w: 200 }),
      makeText(0, 260, ctx.label('story.steps', 'Steps'), {}, { id: ctx.makeId(), fontSize: 20, w: 200 }),
      makeText(0, 520, ctx.label('story.release1', 'Release 1'), {}, { id: ctx.makeId(), fontSize: 20, w: 200 }),
      makeText(0, 1000, ctx.label('story.release2', 'Release 2'), {}, { id: ctx.makeId(), fontSize: 20, w: 200 }),
    ];
    for (let c = 0; c < 4; c++) {
      const x = 240 + c * 240;
      out.push(makeSticky(x, 20, {}, { id: ctx.makeId(), color: STICKY_COLORS[5] }));
      out.push(makeSticky(x, 280, {}, { id: ctx.makeId(), color: STICKY_COLORS[0] }));
      out.push(makeSticky(x, 540, {}, { id: ctx.makeId(), color: STICKY_COLORS[3] }));
      out.push(makeSticky(x, 760, {}, { id: ctx.makeId(), color: STICKY_COLORS[3] }));
    }
    const line = (y: number) => makeConnector({ x: 0, y }, { x: 1200, y }, {}, { id: ctx.makeId(), route: 'straight', endCap: 'none', stroke: '#94a3b8' });
    out.push(line(500), line(980));
    return fragment(out);
  },
};

const customerJourney: BuiltInTemplate = {
  id: 'customer-journey',
  category: 'strategy',
  build: (ctx) => {
    const stages: [string, string][] = [
      ['journey.awareness', 'Awareness'],
      ['journey.consideration', 'Consideration'],
      ['journey.purchase', 'Purchase'],
      ['journey.retention', 'Retention'],
      ['journey.advocacy', 'Advocacy'],
    ];
    const rows: [string, string][] = [
      ['journey.actions', 'Actions'],
      ['journey.thoughts', 'Thoughts'],
      ['journey.pains', 'Pain points'],
      ['journey.ideas', 'Opportunities'],
    ];
    const out: BoardElement[] = [];
    rows.forEach(([key, english], r) => out.push(makeText(0, 120 + r * 240, ctx.label(key, english), {}, { id: ctx.makeId(), fontSize: 20, w: 180 })));
    stages.forEach(([key, english], s) => {
      const x = 200 + s * 260;
      out.push(makeShape('chevron', x, 0, 240, 80, {}, { id: ctx.makeId(), fill: '#dbeafe', text: ctx.label(key, english) }));
      rows.forEach((_, r) => out.push(makeSticky(x + 20, 110 + r * 240, {}, { id: ctx.makeId(), color: [STICKY_COLORS[0], STICKY_COLORS[5], STICKY_COLORS[12], STICKY_COLORS[3]][r]! })));
    });
    return fragment(out);
  },
};

const weeklyPlanning: BuiltInTemplate = {
  id: 'weekly-planning',
  category: 'planning',
  build: (ctx) => {
    const days: [string, string][] = [
      ['week.mon', 'Monday'],
      ['week.tue', 'Tuesday'],
      ['week.wed', 'Wednesday'],
      ['week.thu', 'Thursday'],
      ['week.fri', 'Friday'],
    ];
    return fragment(columns(ctx, days, { width: 300, height: 700, stickies: 1 }).map((e) => (e.type === 'sticky' ? { ...e, x: e.x - 20, w: 240, h: 160 } : e)));
  },
};

const meetingNotes: BuiltInTemplate = {
  id: 'meeting-notes',
  category: 'meetings',
  build: (ctx) =>
    fragment(
      columns(
        ctx,
        [
          ['meeting.agenda', 'Agenda'],
          ['meeting.notes', 'Notes'],
          ['meeting.decisions', 'Decisions'],
          ['meeting.next', 'Next steps'],
        ],
        { width: 460, height: 640, color: (i) => STICKY_COLORS[[0, 13, 3, 5][i]!]! },
      ),
    ),
};

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  retrospective,
  brainstorm,
  mindMap,
  flowchart,
  kanban,
  userStoryMap,
  weeklyPlanning,
  swot,
  leanCanvas,
  customerJourney,
  meetingNotes,
];

export function findTemplate(id: string): BuiltInTemplate | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id);
}
