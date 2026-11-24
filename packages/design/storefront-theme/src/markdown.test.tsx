import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { headingLine, listItemLine, parseInline, parseMarkdown, plainText, RichText } from './markdown';

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(parseMarkdown('One\ntwo\n\nThree')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'One' }, { kind: 'break' }, { kind: 'text', text: 'two' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'Three' }] },
    ]);
  });

  it('reads headings and lists', () => {
    const blocks = parseMarkdown('## Title\n- a\n- b\n### Sub\ntext');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'heading', 'paragraph']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 });
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 3 });
    expect(blocks[1]).toMatchObject({ kind: 'list', items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]] });
  });

  it('treats # and #### as text, not headings', () => {
    expect(parseMarkdown('# one')[0]?.kind).toBe('paragraph');
    expect(parseMarkdown('#### four')[0]?.kind).toBe('paragraph');
  });
});

describe('parseInline', () => {
  it('reads bold, italic and nested emphasis', () => {
    expect(parseInline('a **b *c*** d')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b ' }, { kind: 'em', children: [{ kind: 'text', text: 'c' }] }] },
      { kind: 'text', text: ' d' },
    ]);
  });

  it('leaves unmatched markers as text', () => {
    expect(parseInline('5 * 3 and **open')).toEqual([{ kind: 'text', text: '5 * 3 and **open' }]);
  });

  it('keeps escaped markers', () => {
    expect(parseInline('\\*not italic\\*')).toEqual([{ kind: 'text', text: '*not italic*' }]);
  });

  it('marks http(s) links external and keeps shop paths, mailto and tel internal', () => {
    expect(parseInline('[a](https://example.com/x)')[0]).toMatchObject({ kind: 'link', href: 'https://example.com/x', external: true });
    expect(parseInline('[b](/pages/about)')[0]).toMatchObject({ kind: 'link', href: '/pages/about', external: false });
    expect(parseInline('[c](mailto:hi@example.com)')[0]).toMatchObject({ kind: 'link', external: false });
    expect(parseInline('[d](tel:+31200000000)')[0]).toMatchObject({ kind: 'link', external: false });
  });

  it('draws the label alone for an unsafe link', () => {
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.example', '/\\evil.example', 'java\tscript:alert(1)']) {
      expect(parseInline(`[click](${url})`), url).toEqual([{ kind: 'text', text: 'click' }]);
    }
  });
});

describe('RichText', () => {
  it('renders elements, never HTML from the input', () => {
    const html = renderToStaticMarkup(<RichText source={'<img src=x onerror=alert(1)> **hi**\n\n<script>alert(1)</script>'} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; <strong>hi</strong>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('gives external links rel="noopener noreferrer" and internal ones none', () => {
    const { container } = render(<RichText source="[out](https://example.com) and [in](/products)" />);
    const [out, inside] = Array.from(container.querySelectorAll('a'));
    expect(out?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(out?.getAttribute('href')).toBe('https://example.com/');
    expect(inside?.hasAttribute('rel')).toBe(false);
    expect(inside?.getAttribute('href')).toBe('/products');
  });

  it('shifts heading levels under a section heading', () => {
    const { container } = render(<RichText source={'## A\n### B'} baseLevel={3} />);
    expect(Array.from(container.querySelectorAll('h3, h4')).map((el) => el.tagName)).toEqual(['H3', 'H4']);
  });

  it('draws nothing for an empty or non-string value', () => {
    expect(renderToStaticMarkup(<RichText source="   " />)).toBe('');
    expect(renderToStaticMarkup(<RichText source={42} />)).toBe('');
  });
});

describe('plainText', () => {
  it('drops the markup and shortens', () => {
    expect(plainText('## Hi\n**bold** [link](https://x.example)')).toBe('Hi bold link');
    expect(plainText('word '.repeat(100), 20).length).toBeLessThanOrEqual(20);
  });
});

describe('heading and list item lines', () => {
  // The regular expressions these replaced (they backtrack super-linearly), kept to show the two agree.
  const OLD_HEADING = /^(#{2,3})\s+(.*)$/;
  const OLD_LIST_ITEM = /^\s*[-*]\s+(.*)$/;
  const oldHeading = (line: string) => {
    const match = OLD_HEADING.exec(line);
    return match ? { level: match[1] === '##' ? 2 : 3, text: match[2] ?? '' } : null;
  };
  const oldListItem = (line: string) => {
    const match = OLD_LIST_ITEM.exec(line);
    return match ? (match[1] ?? '') : null;
  };

  const samples = [
    '',
    ' ',
    '#',
    '##',
    '## ',
    '##  ',
    '## Title',
    '##   Title  ',
    '##\tTabbed',
    '### Sub',
    '#### four',
    '# one',
    '##Title',
    '## a\u2028b',
    '##\u2028a',
    '## \u00a0a',
    '-',
    '- ',
    '- a',
    '-  a b ',
    '* a',
    '  - indented',
    '\t* tabbed',
    '-a',
    '--- rule',
    '- - nested',
    '** bold',
    '**bold**',
    '- a\u2029b',
    ' \u2028- a',
    'plain text',
  ];

  it.each(samples)('reads %j as the regular expressions did', (line) => {
    expect(headingLine(line)).toEqual(oldHeading(line));
    expect(listItemLine(line)).toEqual(oldListItem(line));
  });

  it('agrees with them on every short line of markers, spaces and text', () => {
    const alphabet = ['#', '-', '*', ' ', '\t', 'a', '\u2028', '\u00a0'];
    let lines = [''];
    for (let length = 1; length <= 5; length += 1) {
      lines = lines.flatMap((line) => alphabet.map((char) => line + char));
      for (const line of lines) {
        expect(headingLine(line), JSON.stringify(line)).toEqual(oldHeading(line));
        expect(listItemLine(line), JSON.stringify(line)).toEqual(oldListItem(line));
      }
    }
  });

  it('returns the level and the text after the spaces', () => {
    expect(headingLine('##   Title')).toEqual({ level: 2, text: 'Title' });
    expect(headingLine('### Sub')).toEqual({ level: 3, text: 'Sub' });
    expect(headingLine('## ')).toEqual({ level: 2, text: '' });
    expect(headingLine('#### four')).toBeNull();
    expect(listItemLine('  -   a b')).toBe('a b');
    expect(listItemLine('* ')).toBe('');
    expect(listItemLine('-a')).toBeNull();
  });

  it('turns down a long run of spaces before a line separator in linear time', () => {
    // The old expressions tried every split of the spaces here: seconds, not milliseconds.
    const spaces = ' '.repeat(50_000);
    expect(headingLine(`##${spaces}a\u2028`)).toBeNull();
    expect(listItemLine(`-${spaces}a\u2028`)).toBeNull();
  });
});
