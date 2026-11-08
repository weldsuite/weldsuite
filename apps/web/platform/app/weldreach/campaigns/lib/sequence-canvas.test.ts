import { describe, expect, it } from 'vitest';
import { newStep } from './sequence';
import { sequenceToCanvas, stepIndexForNode, type SequenceCanvasText } from './sequence-canvas';

const text: SequenceCanvasText = {
  start: 'Prospect added',
  stepName: (index) => (index === 0 ? 'First email' : `Follow-up ${index}`),
  wait: 'Wait',
  waitSummary: (days, hours) => `${days}d ${hours}h`,
  from: 'From',
  fromValue: 'Campaign mailboxes',
  to: 'To',
  toValue: '{{email}}',
  subject: 'Subject',
  subjectPlaceholder: 'Quick question',
  bodyPlaceholder: 'Hi…',
};

const first = { ...newStep(), delayDays: 0, subject: 'Hello', body: 'Hi there' };

describe('sequenceToCanvas', () => {
  it('draws each email as a send-email node with the compose-card preview', () => {
    const canvas = sequenceToCanvas([first], ['a'], text);

    expect(canvas.trigger).toMatchObject({ id: 'trigger', name: 'Prospect added' });
    expect(canvas.steps).toHaveLength(1);
    expect(canvas.steps[0]).toMatchObject({
      id: 'email-a',
      type: 'send_email',
      name: 'First email',
      config: { to: '{{email}}', subject: 'Hello', body: 'Hi there' },
      emailPreview: {
        rows: [
          { label: 'From', value: 'Campaign mailboxes' },
          { label: 'To', value: '{{email}}' },
          { label: 'Subject', value: 'Hello', placeholder: 'Quick question' },
        ],
        body: 'Hi there',
      },
    });
  });

  it('puts a wait node before a follow-up that waits, and none before one that does not', () => {
    const canvas = sequenceToCanvas(
      [first, { ...newStep(), delayDays: 2, delayHours: 3 }, { ...newStep(), delayDays: 0, delayHours: 0 }],
      ['a', 'b', 'c'],
      text,
    );

    expect(canvas.steps.map((step) => step.id)).toEqual(['email-a', 'wait-b', 'email-b', 'email-c']);
    expect(canvas.steps[1]).toMatchObject({ type: 'delay', name: 'Wait', summary: '2d 3h', config: { days: 2, hours: 3 } });
    expect(canvas.nodes).toEqual([
      { index: 0, part: 'email' },
      { index: 1, part: 'wait' },
      { index: 1, part: 'email' },
      { index: 2, part: 'email' },
    ]);
  });

  it('finds the step a node belongs to, and nothing for the start node', () => {
    const canvas = sequenceToCanvas([first, newStep()], ['a', 'b'], text);

    expect(stepIndexForNode(canvas, 'wait-b')).toBe(1);
    expect(stepIndexForNode(canvas, 'email-b')).toBe(1);
    expect(stepIndexForNode(canvas, 'trigger')).toBeNull();
    expect(stepIndexForNode(canvas, undefined)).toBeNull();
  });
});
