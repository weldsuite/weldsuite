import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The real chip pulls in the entity sheet (router, queries); the renderer only needs a placeholder.
vi.mock('../components/entity-mention-chip', () => ({
  EntityMentionChip: ({ type, id, fallbackLabel }: { type: string; id: string; fallbackLabel: string | null }) => (
    <span data-chip={`${type}:${id}`}>{fallbackLabel}</span>
  ),
}));

import { MAX_EMPHASIS_CHARS, renderMessageContent } from './render-message-content';

const html = (text: string, members?: Map<string, string>) =>
  renderToStaticMarkup(<>{renderMessageContent(text, members)}</>);

describe('renderMessageContent', () => {
  it('returns plain text unchanged', () => {
    expect(html('hello world')).toBe('hello world');
  });

  describe('inline formatting', () => {
    it('renders bold, italic, underline, strike and code', () => {
      expect(html('**b**')).toBe('<strong>b</strong>');
      expect(html('*i*')).toBe('<em>i</em>');
      expect(html('_i_')).toBe('<em>i</em>');
      expect(html('__u v__')).toBe('<span class="underline">u v</span>');
      expect(html('~~s~~')).toBe('<span class="line-through">s</span>');
      expect(html('`c`')).toContain('<code');
      expect(html('`c`')).toContain('>c</code>');
    });

    it('does not treat spaced asterisks as emphasis (2 * 3 * 4)', () => {
      expect(html('2 * 3 * 4')).toBe('2 * 3 * 4');
    });

    it('does not trigger on markers inside words', () => {
      expect(html('2*3*4')).toBe('2*3*4');
      expect(html('snake_case_name')).toBe('snake_case_name');
    });

    it('keeps a marker literal unless it opens before and closes after a non-space', () => {
      expect(html('** not bold **')).toBe('** not bold **');
      expect(html('**bold **')).toBe('**bold **');
    });

    it('does not underline dunder identifiers like __init__', () => {
      expect(html('__init__')).toBe('__init__');
      expect(html('call __init__.py now')).toBe('call __init__.py now');
    });

    it('still underlines multi-word __text__', () => {
      expect(html('__two words__')).toBe('<span class="underline">two words</span>');
    });

    it('nests bold + italic (***both***)', () => {
      const out = html('***both***');
      expect(out).toContain('<strong>both</strong>');
      expect(out).toContain('<em>');
    });

    it('nests italic inside bold with surrounding text (the composer output for **a *b* c**)', () => {
      expect(html('**a *b* c**')).toBe('<strong>a <em>b</em> c</strong>');
    });

    it('nests bold + italic written as ** and _', () => {
      expect(html('**_x_**')).toBe('<strong><em>x</em></strong>');
    });

    it('handles italic ending a bold run (**a *b***)', () => {
      expect(html('**a *b***')).toBe('<strong>a <em>b</em></strong>');
    });

    it('formats around other text', () => {
      expect(html('say **hi** to *you*')).toBe('say <strong>hi</strong> to <em>you</em>');
    });

    it('does not format inside code spans', () => {
      const out = html('`**x**`');
      expect(out).not.toContain('<strong>');
      expect(out).toContain('**x**');
    });
  });

  describe('links', () => {
    it('links http and https URLs safely', () => {
      const out = html('see https://example.com/a?b=1 now');
      expect(out).toContain('<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer"');
      expect(out).toContain('>https://example.com/a?b=1</a> now');
      expect(html('http://example.com')).toContain('href="http://example.com"');
    });

    it('leaves trailing punctuation outside the link', () => {
      expect(html('go to https://example.com.')).toContain('>https://example.com</a>.');
      expect(html('(https://example.com/x)')).toContain('>https://example.com/x</a>)');
      expect(html('https://example.com/a_(b)')).toContain('href="https://example.com/a_(b)"');
      expect(html('really? https://example.com!')).toContain('>https://example.com</a>!');
    });

    it('does not let emphasis markers swallow the URL end', () => {
      const out = html('**https://example.com**');
      expect(out).toContain('<strong><a href="https://example.com"');
    });

    it('never links javascript: or other schemes', () => {
      expect(html('javascript:alert(1)')).not.toContain('<a');
      expect(html('click javascript://x%0Aalert(1)')).not.toContain('<a');
      expect(html('ftp://example.com')).not.toContain('<a');
      expect(html('[x](javascript:alert(1))')).not.toContain('<a');
    });

    it('does not link a bare scheme with no host', () => {
      expect(html('https://')).not.toContain('<a');
    });

    it('does not link URLs glued to a preceding word', () => {
      expect(html('xhttps://example.com')).not.toContain('<a');
    });
  });

  describe('safety', () => {
    it('keeps HTML escaped', () => {
      const out = html('<img src=x onerror=alert(1)> <script>x</script>');
      expect(out).not.toContain('<img');
      expect(out).not.toContain('<script');
      expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes HTML inside formatting and links', () => {
      expect(html('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    });

    it('is not confused by a private-use character in the text', () => {
      const out = html('ab <@u1> c');
      expect(out).toContain('@u1');
      expect(out).toContain('a');
    });
  });

  describe('mentions', () => {
    it('renders user mentions with the member name', () => {
      const members = new Map([['u1', 'Gert']]);
      expect(html('hi <@u1>!', members)).toContain('@Gert');
    });

    it('prefers the name override and falls back to the id', () => {
      expect(html('<@u1:Override>')).toContain('@Override');
      expect(html('<@u2>')).toContain('@u2');
    });

    it('renders @everyone', () => {
      expect(html('<@everyone> hello')).toContain('@everyone');
    });

    it('renders entity tokens as chips', () => {
      const out = html('see <@customer:cus_1|Acme>');
      expect(out).toContain('data-chip="customer:cus_1"');
      expect(out).toContain('Acme');
    });

    it('formats text across a mention', () => {
      const out = html('**hello <@u1>**', new Map([['u1', 'Gert']]));
      expect(out).toContain('<strong>hello ');
      expect(out).toContain('@Gert');
      expect(out).toContain('</strong>');
    });

    it('does not link or format inside a mention token', () => {
      const out = html('<@u1:a*b*c>');
      expect(out).toContain('@a*b*c');
      expect(out).not.toContain('<em>');
    });
  });
  describe('markers next to letters and emoji (what the composer emits)', () => {
    it('formats bold followed by an astral emoji', () => {
      expect(html('**done**\u{1F389}')).toBe('<strong>done</strong>\u{1F389}');
      expect(html('\u{1F389}**done**')).toBe('\u{1F389}<strong>done</strong>');
    });

    it('formats bold inside a word', () => {
      expect(html('**foo**bar')).toBe('<strong>foo</strong>bar');
      expect(html('foo**bar**')).toBe('foo<strong>bar</strong>');
    });

    it('formats **Note:**text', () => {
      expect(html('**Note:**text')).toBe('<strong>Note:</strong>text');
    });

    it('formats adjacent runs', () => {
      expect(html('**a****b**')).toBe('<strong>a</strong><strong>b</strong>');
      expect(html('**a**~~b~~')).toBe('<strong>a</strong><span class="line-through">b</span>');
      expect(html('**a***b*')).toBe('<strong>a</strong><em>b</em>');
    });

    it('formats strike next to letters', () => {
      expect(html('x~~gone~~y')).toBe('x<span class="line-through">gone</span>y');
    });

    it('still leaves spaced and intraword single markers literal', () => {
      expect(html('2 * 3 * 4')).toBe('2 * 3 * 4');
      expect(html('2*3*4')).toBe('2*3*4');
      expect(html('2 ** 3 ** 4')).toBe('2 ** 3 ** 4');
      expect(html('snake_case_name')).toBe('snake_case_name');
      expect(html('__init__')).toBe('__init__');
      expect(html('a ~~ b ~~ c')).toBe('a ~~ b ~~ c');
    });

    it('treats single * and _ next to an emoji by the word-boundary rule', () => {
      expect(html('*done*\u{1F389}')).toBe('<em>done</em>\u{1F389}');
    });
  });

  describe('mention chips next to URLs', () => {
    it('does not swallow a chip glued to the end of a URL', () => {
      const out = html('see https://example.com/a<@u1> and <@u2>', new Map([['u1', 'Ann'], ['u2', 'Bob']]));
      expect(out).toContain('href="https://example.com/a"');
      expect(out).toContain('@Ann');
      expect(out).toContain('@Bob');
      expect(out.indexOf('@Ann')).toBeLessThan(out.indexOf('@Bob'));
    });

    it('keeps every chip in order when several follow links', () => {
      const out = html('https://a.com<@u1> https://b.com<@u2> <@u3>', new Map([['u1', 'A'], ['u2', 'B'], ['u3', 'C']]));
      expect(out.match(/@[ABC]</g)).toEqual(['@A<', '@B<', '@C<']);
    });
  });

  describe('pathological input', () => {
    const budgetMs = 1500;
    const time = (text: string) => {
      const start = performance.now();
      html(text);
      return performance.now() - start;
    };

    it('renders a 100 KB message of unmatched markers quickly (above the emphasis cap)', () => {
      for (const unit of ['x* ', '**a ', '__a ', '~~a ', '\x60 ', 'h ', '*a ', '(']) {
        const text = unit.repeat(Math.ceil(100_000 / unit.length));
        expect(text.length).toBeGreaterThan(MAX_EMPHASIS_CHARS);
        expect(time(text)).toBeLessThan(budgetMs);
      }
    });

    it('stays linear just under the cap, where emphasis is still parsed', () => {
      for (const unit of ['x* ', '*a ', '**a ', '__a ', '~~a ', '*a** ', '_a_ *a* **a** ']) {
        const text = unit.repeat(Math.floor(MAX_EMPHASIS_CHARS / unit.length));
        expect(time(text)).toBeLessThan(budgetMs);
      }
    });

    it('skips emphasis above the cap but still links and renders mentions', () => {
      const out = html('**bold** https://example.com <@u1> ' + 'x'.repeat(MAX_EMPHASIS_CHARS), new Map([['u1', 'Ann']]));
      expect(out).not.toContain('<strong>');
      expect(out).toContain('href="https://example.com"');
      expect(out).toContain('@Ann');
    });

    it('does not link an enormous URL', () => {
      const out = html('https://example.com/' + 'a'.repeat(5000));
      expect(out).not.toContain('<a');
    });

    it('does not go quadratic on a long run of closing brackets in a URL', () => {
      expect(time('https://example.com/' + ')'.repeat(2000))).toBeLessThan(budgetMs);
    });
  });
});
