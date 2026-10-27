import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The real chip pulls in the entity sheet (router, queries); the renderer only needs a placeholder.
vi.mock('../components/entity-mention-chip', () => ({
  EntityMentionChip: ({ type, id, fallbackLabel }: { type: string; id: string; fallbackLabel: string | null }) => (
    <span data-chip={`${type}:${id}`}>{fallbackLabel}</span>
  ),
}));

import { MAX_EMPHASIS_CHARS } from './render-message-content';
import { hasBlockMarkup, parseMessageBlocks, renderMessageBlocks } from './render-message-blocks';

const html = (text: string, members?: Map<string, string>) =>
  renderToStaticMarkup(<>{renderMessageBlocks(text, members)}</>);

/** Markup without the class attributes, so the structure reads on its own. */
const structure = (text: string) => html(text).replaceAll(/ class="[^"]*"/g, '').replaceAll(/ start="\d+"/g, '');

describe('parseMessageBlocks', () => {
  it('keeps plain text as one paragraph, line breaks included', () => {
    expect(parseMessageBlocks('one\ntwo')).toEqual([{ kind: 'paragraph', text: 'one\ntwo' }]);
  });

  it('splits paragraphs on blank lines', () => {
    expect(parseMessageBlocks('first\n\n\nsecond')).toEqual([
      { kind: 'paragraph', text: 'first' },
      { kind: 'paragraph', text: 'second' },
    ]);
  });

  it('reads dash, star, plus and bullet lists', () => {
    for (const marker of ['-', '*', '+', '•']) {
      expect(parseMessageBlocks(`${marker} a\n${marker} b`)).toEqual([
        { kind: 'list', ordered: false, start: 1, items: [[{ kind: 'paragraph', text: 'a' }], [{ kind: 'paragraph', text: 'b' }]] },
      ]);
    }
  });

  it('reads numbered lists and keeps the first number', () => {
    expect(parseMessageBlocks('3. c\n4) d')).toEqual([
      { kind: 'list', ordered: true, start: 3, items: [[{ kind: 'paragraph', text: 'c' }], [{ kind: 'paragraph', text: 'd' }]] },
    ]);
  });

  it('is not fooled by bold or negative numbers at the start of a line', () => {
    expect(parseMessageBlocks('**Done** is bold')).toEqual([{ kind: 'paragraph', text: '**Done** is bold' }]);
    expect(parseMessageBlocks('-5 degrees')).toEqual([{ kind: 'paragraph', text: '-5 degrees' }]);
    expect(parseMessageBlocks('*italic* start')).toEqual([{ kind: 'paragraph', text: '*italic* start' }]);
  });

  it('keeps a loose list (blank lines between items) as one list', () => {
    const [block] = parseMessageBlocks('- a\n\n- b\n\n- c');
    expect(block).toMatchObject({ kind: 'list' });
    expect((block as { items: unknown[] }).items).toHaveLength(3);
  });

  it('nests an indented list under its item', () => {
    const [list] = parseMessageBlocks('- parent\n  - child one\n  - child two\n- next');
    expect(list).toMatchObject({ kind: 'list', ordered: false });
    const items = (list as { items: Array<Array<{ kind: string }>> }).items;
    expect(items).toHaveLength(2);
    expect(items[0].map((b) => b.kind)).toEqual(['paragraph', 'list']);
  });

  it('nests under a numbered item with only two spaces of indent', () => {
    const [list] = parseMessageBlocks('1. step\n  - detail\n2. step two');
    const items = (list as { items: Array<Array<{ kind: string }>> }).items;
    expect(items).toHaveLength(2);
    expect(items[0].map((b) => b.kind)).toEqual(['paragraph', 'list']);
  });

  it('a wrapped line belongs to the item above it', () => {
    expect(parseMessageBlocks('- first line\nwrapped on')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [[{ kind: 'paragraph', text: 'first line\nwrapped on' }]] },
    ]);
  });

  it('a paragraph after a blank line ends the list', () => {
    expect(parseMessageBlocks('- a\n\nafter')).toEqual([
      { kind: 'list', ordered: false, start: 1, items: [[{ kind: 'paragraph', text: 'a' }]] },
      { kind: 'paragraph', text: 'after' },
    ]);
  });

  it('a list can interrupt a paragraph', () => {
    expect(parseMessageBlocks('Here is the status:\n- one\n- two').map((b) => b.kind)).toEqual(['paragraph', 'list']);
  });

  it('switching between bullets and numbers starts a new list', () => {
    expect(parseMessageBlocks('- a\n1. b').map((b) => b.kind)).toEqual(['list', 'list']);
  });

  it('reads headings, rules, quotes and fenced code', () => {
    expect(parseMessageBlocks('# One\n## Two\n#### Deep')).toEqual([
      { kind: 'heading', level: 1, text: 'One' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'heading', level: 3, text: 'Deep' },
    ]);
    expect(parseMessageBlocks('a\n\n---\n\nb').map((b) => b.kind)).toEqual(['paragraph', 'rule', 'paragraph']);
    expect(parseMessageBlocks('> quoted\n> more')).toEqual([
      { kind: 'quote', blocks: [{ kind: 'paragraph', text: 'quoted\nmore' }] },
    ]);
    expect(parseMessageBlocks('```ts\nconst a = 1;\n- not a list\n```\nafter')).toEqual([
      { kind: 'code', text: 'const a = 1;\n- not a list' },
      { kind: 'paragraph', text: 'after' },
    ]);
  });

  it('runs an unclosed fence to the end of the message', () => {
    expect(parseMessageBlocks('```\nopen\nstill code')).toEqual([{ kind: 'code', text: 'open\nstill code' }]);
  });

  it('does not nest forever', () => {
    const deep = Array.from({ length: 12 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n');
    expect(() => parseMessageBlocks(deep)).not.toThrow();
  });

  it('handles CRLF and tab-indented lists', () => {
    expect(parseMessageBlocks('- a\r\n\t- b\r\n- c').map((b) => b.kind)).toEqual(['list']);
  });

  it('reports whether there is anything but a plain paragraph', () => {
    expect(hasBlockMarkup(parseMessageBlocks('just text'))).toBe(false);
    expect(hasBlockMarkup(parseMessageBlocks('- item'))).toBe(true);
    expect(hasBlockMarkup(parseMessageBlocks('one\n\ntwo'))).toBe(true);
    expect(hasBlockMarkup(parseMessageBlocks(''))).toBe(false);
  });
});

describe('renderMessageBlocks', () => {
  it('renders a plain message exactly like the inline renderer (no wrapper)', () => {
    expect(html('hello **world**')).toBe('hello <strong>world</strong>');
  });

  it('renders a bulleted list as ul/li, with no literal dashes', () => {
    const out = structure('Status:\n\n- **Done**: the report\n- Next: review');
    expect(out).toBe(
      '<div><p>Status:</p><ul><li><div><strong>Done</strong>: the report</div></li><li><div>Next: review</div></li></ul></div>',
    );
    expect(out).not.toContain('- ');
  });

  it('renders a numbered list as ol with its start number', () => {
    const out = html('2. two\n3. three');
    expect(out).toContain('<ol');
    expect(out).toContain('start="2"');
    expect(out).not.toContain('2. two');
  });

  it('renders nested lists inside the parent item', () => {
    expect(structure('- a\n  - b')).toBe('<div><ul><li><div>a</div><ul><li><div>b</div></li></ul></li></ul></div>');
  });

  it('keeps single line breaks inside a paragraph, and separates paragraphs by element, not blank lines', () => {
    const out = structure('line one\nline two\n\nsecond paragraph');
    expect(out).toBe('<div><p>line one\nline two</p><p>second paragraph</p></div>');
  });

  it('renders mention chips and links inside list items', () => {
    const members = new Map([['user_1', 'Gert']]);
    const out = html('- ask <@user_1>\n- see https://example.com/a', members);
    expect(out).toContain('@Gert');
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('renders record chips inside list items', () => {
    expect(html('- <@task:tsk_1|Fix login>')).toContain('data-chip="task:tsk_1"');
  });

  it('renders fenced code verbatim, without parsing mentions or emphasis', () => {
    const out = html('```\n**not bold** <@user_1>\n```');
    expect(out).toContain('<pre');
    expect(out).toContain('**not bold** &lt;@user_1&gt;');
    expect(out).not.toContain('<strong>');
  });

  it('never emits markup from message text', () => {
    const out = html('- <script>alert(1)</script>\n- <img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('renders headings, rules and quotes', () => {
    expect(structure('# Title\n\n---\n\n> note')).toBe(
      '<div><p>Title</p><hr/><blockquote><p>note</p></blockquote></div>',
    );
  });

  it('falls back to the inline renderer for a very long message', () => {
    const long = `- item ${'x'.repeat(MAX_EMPHASIS_CHARS)}`;
    expect(html(long)).not.toContain('<ul');
  });
});

describe('tables', () => {
  const table = [
    'Open tasks:',
    '| # | Task | Assigned to |',
    '|---|:---|---:|',
    '| 1 | **E2E task one** | No one |',
    '| 2 | Mobile QA task | Maestro |',
  ].join('\n');

  it('reads a header, the delimiter row and the body rows, with alignment', () => {
    expect(parseMessageBlocks(table)).toEqual([
      { kind: 'paragraph', text: 'Open tasks:' },
      {
        kind: 'table',
        header: ['#', 'Task', 'Assigned to'],
        align: [null, 'left', 'right'],
        rows: [
          ['1', '**E2E task one**', 'No one'],
          ['2', 'Mobile QA task', 'Maestro'],
        ],
      },
    ]);
  });

  it('works without outer pipes, pads short rows and keeps an escaped pipe in a cell', () => {
    expect(parseMessageBlocks(['a | b', '--- | ---', String.raw`x \| y`, '1 | 2'].join('\n'))).toEqual([
      { kind: 'table', header: ['a', 'b'], align: [null, null], rows: [['x | y', ''], ['1', '2']] },
    ]);
  });

  it('is not a table without a delimiter row, or when the delimiter does not match the header', () => {
    expect(parseMessageBlocks('a | b\nc | d')).toEqual([{ kind: 'paragraph', text: 'a | b\nc | d' }]);
    expect(parseMessageBlocks('| a | b |\n|---|')[0].kind).toBe('paragraph');
  });

  it('renders a scrollable table with inline formatting in its cells', () => {
    const out = html(table);
    expect(out).toContain('overflow-x-auto');
    expect(structure(table)).toContain(
      '<table><thead><tr><th>#</th><th>Task</th><th>Assigned to</th></tr></thead><tbody><tr><td>1</td><td><strong>E2E task one</strong></td><td>No one</td></tr>',
    );
    expect(out).not.toContain('|---|');
  });
});
