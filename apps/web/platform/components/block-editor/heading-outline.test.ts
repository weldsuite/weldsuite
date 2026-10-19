import { describe, expect, it } from 'vitest';
import { collectOutline } from './heading-outline';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

describe('collectOutline', () => {
  it('lists headings in order with the text under each as its preview', () => {
    const outline = collectOutline([
      { id: 'intro', type: 'paragraph', content: text('Before any heading') },
      { id: 'h1', type: 'heading', props: { level: 1 }, content: text('Triage') },
      { id: 'p1', type: 'paragraph', content: text('Press g then i.') },
      { id: 'p2', type: 'paragraph', content: text('Everything in one place.') },
      { id: 'h2', type: 'heading', props: { level: 2 }, content: text('Assign') },
    ]);

    expect(outline).toEqual([
      { id: 'h1', level: 1, text: 'Triage', preview: 'Press g then i. Everything in one place.' },
      { id: 'h2', level: 2, text: 'Assign', preview: '' },
    ]);
  });

  it('includes headings and text nested inside other blocks', () => {
    const outline = collectOutline([
      {
        id: 'toggle',
        type: 'toggleListItem',
        content: text('Details'),
        children: [{ id: 'h', type: 'heading', props: { level: 3 }, content: text('Nested') }],
      },
      { id: 'p', type: 'paragraph', content: text('After it') },
    ]);

    expect(outline).toEqual([{ id: 'h', level: 3, text: 'Nested', preview: 'After it' }]);
  });
});
