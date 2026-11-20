import { describe, expect, it } from 'vitest';
import {
  CHAT_VISUAL_LIMITS,
  encodeVisualMarker,
  extractVisuals,
  parseChatVisual,
  replyToPlainText,
  showChartInputSchema,
  splitReplyParts,
  visualFileName,
  visualFromToolCall,
  visualToCsv,
  type ChatVisual,
} from './chat-visuals';
import { encodeQuestionMarker } from './weldagent-questions';
import { recordPagePath } from './record-links';

const chart: ChatVisual = {
  type: 'chart',
  kind: 'bar',
  title: 'Open tickets per status',
  labels: ['Open', 'Pending', 'Solved'],
  series: [{ name: 'Tickets', values: [12, 4, 30] }],
};

const table: ChatVisual = {
  type: 'table',
  title: 'Top deals',
  columns: [{ label: 'Deal' }, { label: 'Amount', format: { style: 'currency', currency: 'EUR' } }],
  rows: [
    ['Acme, renewal', 12000],
    ['Globex "big" deal', 8000.5],
  ],
};

describe('chatVisualSchema', () => {
  it('accepts each visual type', () => {
    expect(parseChatVisual(chart)).toEqual(chart);
    expect(parseChatVisual(table)).toEqual(table);
    expect(
      parseChatVisual({ type: 'stats', items: [{ label: 'Revenue', value: 1200, change: 12.5, positiveIsGood: true }] }),
    ).not.toBeNull();
    expect(
      parseChatVisual({
        type: 'records',
        items: [{ entityType: 'task', id: 'tsk_1', label: 'Ship it', status: 'Open' }],
      }),
    ).not.toBeNull();
  });

  it('rejects a series with the wrong number of values', () => {
    const bad = { ...chart, series: [{ name: 'Tickets', values: [1, 2] }] };
    expect(parseChatVisual(bad)).toBeNull();
    expect(showChartInputSchema.safeParse({ ...bad, type: undefined }).success).toBe(false);
  });

  it('rejects a row with the wrong number of cells', () => {
    expect(parseChatVisual({ ...table, rows: [['only one']] })).toBeNull();
  });

  it('enforces the size limits', () => {
    const labels = Array.from({ length: CHAT_VISUAL_LIMITS.chartPoints + 1 }, (_, i) => `L${i}`);
    expect(parseChatVisual({ ...chart, labels, series: [{ name: 'x', values: labels.map(() => 1) }] })).toBeNull();
    expect(
      parseChatVisual({
        type: 'records',
        items: [{ entityType: 'not_a_type', id: '1', label: 'x' }],
      }),
    ).toBeNull();
  });

  it('never accepts colours or markup', () => {
    const parsed = parseChatVisual({ ...chart, color: '#f00', html: '<b>x</b>' });
    expect(parsed).not.toHaveProperty('color');
    expect(parsed).not.toHaveProperty('html');
  });
});

describe('visualFromToolCall', () => {
  it('maps a show_* call to its visual', () => {
    const { type: _type, ...args } = chart;
    expect(visualFromToolCall('show_chart', args)).toEqual(chart);
  });

  it('returns null for other tools and bad args', () => {
    expect(visualFromToolCall('ask_user', {})).toBeNull();
    expect(visualFromToolCall('show_chart', { title: 'x' })).toBeNull();
    expect(visualFromToolCall('show_chart', null)).toBeNull();
  });
});

describe('splitReplyParts', () => {
  it('keeps visuals where the reply placed them', () => {
    const raw = `Here is the breakdown.\n\n${encodeVisualMarker(chart)}\n\nMost are solved.`;
    expect(splitReplyParts(raw).parts).toEqual([
      { kind: 'text', text: 'Here is the breakdown.' },
      { kind: 'visual', visual: chart },
      { kind: 'text', text: 'Most are solved.' },
    ]);
  });

  it('shows a visual still streaming in as pending', () => {
    const marker = encodeVisualMarker(chart);
    const raw = `Look:\n\n${marker.slice(0, 30)}`;
    expect(splitReplyParts(raw).parts).toEqual([{ kind: 'text', text: 'Look:' }, { kind: 'pending-visual' }]);
    expect(splitReplyParts('Look:\u001e').parts).toEqual([{ kind: 'text', text: 'Look:' }]);
  });

  it('lifts out questions too', () => {
    const question = { question: 'Which period?', options: [{ label: 'Month' }, { label: 'Year' }] };
    const raw = `Sure.${encodeQuestionMarker(question)}`;
    const split = splitReplyParts(raw);
    expect(split.parts).toEqual([{ kind: 'text', text: 'Sure.' }]);
    expect(split.questions).toEqual([question]);
  });

  it('drops a malformed marker', () => {
    expect(splitReplyParts('a\u001evisual:{nope\u001eb').parts).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
  });
});

describe('replyToPlainText', () => {
  const raw = `Here.\n\n${encodeVisualMarker(chart)}`;

  it('names each visual on one line', () => {
    expect(replyToPlainText(raw)).toBe('Here.\n\n[Chart: Open tickets per status]');
  });

  it('includes the data for the model history', () => {
    expect(replyToPlainText(raw, { detail: 'data' })).toBe(
      'Here.\n\n[Chart: Open tickets per status — shown to the user: Tickets: Open 12, Pending 4, Solved 30]',
    );
  });

  it('leaves a reply without markers alone', () => {
    expect(replyToPlainText('  plain  ')).toBe('  plain  ');
  });
});

describe('extractVisuals', () => {
  it('splits the text from the visuals', () => {
    expect(extractVisuals(`One.\n\n${encodeVisualMarker(chart)}\n\nTwo.${encodeVisualMarker(table)}`)).toEqual({
      text: 'One.\n\nTwo.',
      visuals: [chart, table],
    });
  });
});

describe('visualToCsv', () => {
  it('writes a chart with one column per series', () => {
    expect(visualToCsv(chart)).toBe('Label,Tickets\r\nOpen,12\r\nPending,4\r\nSolved,30');
  });

  it('quotes cells that need it', () => {
    expect(visualToCsv(table)).toBe('Deal,Amount\r\n"Acme, renewal",12000\r\n"Globex ""big"" deal",8000.5');
  });

  it('takes translated headers', () => {
    expect(visualToCsv(chart, { label: 'Label NL' }).split('\r\n')[0]).toBe('Label NL,Tickets');
  });
});

describe('visualFileName', () => {
  it('slugs the title', () => {
    expect(visualFileName(chart, 'csv')).toBe('open-tickets-per-status.csv');
  });
});

describe('recordPagePath', () => {
  it('links records that have a page', () => {
    expect(recordPagePath('task', 'tsk_1')).toBe('/weldflow/task/tsk_1');
    expect(recordPagePath('lead', 'led_1')).toBeNull();
  });
});
