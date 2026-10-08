import { describe, expect, it } from 'vitest';
import { collectHeadings } from './table-of-contents';

describe('collectHeadings', () => {
  it('lists headings in reading order, including nested ones, with their text', () => {
    const blocks = [
      { id: 'a', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'Intro' }], children: [] },
      { id: 'b', type: 'paragraph', content: [{ type: 'text', text: 'body' }], children: [] },
      {
        id: 'c',
        type: 'toggleListItem',
        content: [],
        children: [
          {
            id: 'd',
            type: 'heading',
            props: { level: 3 },
            content: [
              { type: 'text', text: 'See ' },
              { type: 'link', href: 'https://example.com', content: [{ type: 'text', text: 'the docs' }] },
            ],
            children: [],
          },
        ],
      },
      { id: 'e', type: 'heading', props: { level: 2 }, content: [], children: [] },
    ];

    expect(collectHeadings(blocks)).toEqual([
      { id: 'a', level: 1, text: 'Intro' },
      { id: 'd', level: 3, text: 'See the docs' },
      { id: 'e', level: 2, text: '' },
    ]);
  });

  it('returns nothing for a document without headings or for junk input', () => {
    expect(collectHeadings([{ id: 'a', type: 'paragraph', content: [] }])).toEqual([]);
    expect(collectHeadings(null)).toEqual([]);
  });
});
