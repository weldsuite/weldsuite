import { describe, it, expect } from 'vitest';
import { buildComposeBodies, htmlToPlainText, plainTextToHtml } from './compose-body';

describe('htmlToPlainText', () => {
  it('strips formatting tags and keeps the words', () => {
    expect(htmlToPlainText('<div>This sentence is <b>bold</b>.</div><div><i>This one is italic.</i></div>')).toBe(
      'This sentence is bold.\nThis one is italic.',
    );
  });

  it('turns each editor line into a line break', () => {
    expect(htmlToPlainText('first<div>second</div><div>third</div>')).toBe('first\nsecond\nthird');
  });

  it('keeps an empty editor line as a blank line', () => {
    expect(htmlToPlainText('<div>a</div><div><br></div><div>b</div>')).toBe('a\n\nb');
  });

  it('renders <br> as a line break', () => {
    expect(htmlToPlainText('a<br>b')).toBe('a\nb');
  });

  it('renders list items on their own lines', () => {
    expect(htmlToPlainText('<ul><li>one</li><li>two</li></ul><ol><li>three</li></ol>')).toBe(
      '- one\n- two\n- three',
    );
  });

  it('decodes entities and non-breaking spaces', () => {
    expect(htmlToPlainText('<div>Fish &amp; chips&nbsp;&lt;3</div>')).toBe('Fish & chips <3');
  });

  it('leaves no markup behind, scripts and styles included', () => {
    const text = htmlToPlainText('<style>p{color:red}</style><p>Hi <a href="https://x.test">there</a></p><script>alert(1)</script>');
    expect(text).toBe('Hi there');
    expect(text).not.toMatch(/[<>]/);
  });

  it('returns plain text unchanged and empty input as empty', () => {
    expect(htmlToPlainText('just text')).toBe('just text');
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText('<div><br></div>')).toBe('');
  });

  it('collapses runs of blank lines', () => {
    expect(htmlToPlainText('<div>a</div><div><br></div><div><br></div><div><br></div><div>b</div>')).toBe('a\n\nb');
  });
});

describe('plainTextToHtml', () => {
  it('escapes markup and keeps line breaks', () => {
    expect(plainTextToHtml('a < b\nc & d')).toBe('a &lt; b<br>c &amp; d');
  });

  it('round-trips through htmlToPlainText', () => {
    const text = 'Dear Sam,\n\n1 < 2 & 3 > 2\nBye';
    expect(htmlToPlainText(plainTextToHtml(text))).toBe(text);
  });
});

describe('buildComposeBodies', () => {
  it('sends tag-free text as body and the markup as htmlBody', () => {
    const html = '<div>This sentence is bold.</div><div><i>This one is italic.</i></div>';
    const { body, htmlBody } = buildComposeBodies(`  ${html}  `);
    expect(body).toBe('This sentence is bold.\nThis one is italic.');
    expect(htmlBody).toBe(html);
  });

  it('gives line breaks to a plain-text editor value', () => {
    expect(buildComposeBodies('a\nb')).toEqual({ body: 'a\nb', htmlBody: 'a<br>b' });
  });

  it('has an empty body for an editor that only holds an empty line', () => {
    expect(buildComposeBodies('<div><br></div>').body).toBe('');
  });
});
