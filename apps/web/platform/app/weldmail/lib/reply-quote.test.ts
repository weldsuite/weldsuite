import { describe, expect, it } from 'vitest';
import { appendQuotedOriginal, quoteSender } from './reply-quote';

describe('quoteSender', () => {
  it('shows the name with the address when both are known', () => {
    expect(quoteSender('Jane Doe', 'jane@example.com')).toBe('Jane Doe <jane@example.com>');
    expect(quoteSender({ name: 'Jane Doe', email: 'jane@example.com' })).toBe('Jane Doe <jane@example.com>');
  });

  it('falls back to whichever one there is', () => {
    expect(quoteSender('jane@example.com', 'jane@example.com')).toBe('jane@example.com');
    expect(quoteSender('Jane Doe <jane@example.com>', 'jane@example.com')).toBe('Jane Doe <jane@example.com>');
    expect(quoteSender(undefined, 'jane@example.com')).toBe('jane@example.com');
    expect(quoteSender(undefined)).toBe('');
  });
});

const HEADER = 'On {date}, {sender} wrote:';
const reply = { body: 'Sounds good', htmlBody: '<p>Sounds good</p>' };

describe('appendQuotedOriginal', () => {
  it('quotes an HTML original in both parts', () => {
    const out = appendQuotedOriginal(
      reply,
      { sender: 'Jane <jane@example.com>', sentAt: '2026-10-20T09:00:00Z', html: '<p>Can we meet?</p><p>Thu 10:00</p>' },
      HEADER,
      'en-US',
    );

    expect(out.body.startsWith('Sounds good\n\nOn ')).toBe(true);
    expect(out.body).toContain('Jane <jane@example.com> wrote:\n> Can we meet?\n> Thu 10:00');
    expect(out.htmlBody.startsWith('<p>Sounds good</p><br><div class="gmail_quote">')).toBe(true);
    expect(out.htmlBody).toContain('Jane &lt;jane@example.com&gt; wrote:');
    expect(out.htmlBody).toContain('<blockquote class="gmail_quote"');
    expect(out.htmlBody).toContain('<p>Can we meet?</p><p>Thu 10:00</p></blockquote></div>');
  });

  it('quotes a text-only original and keeps its line breaks in the HTML', () => {
    const out = appendQuotedOriginal(reply, { sender: 'Jane', text: 'line one\nline two' }, HEADER);

    expect(out.body).toContain('Jane wrote:\n> line one\n> line two');
    expect(out.htmlBody).toContain('line one<br>line two</blockquote>');
  });

  it('leaves the reply alone when the original has no content', () => {
    expect(appendQuotedOriginal(reply, { sender: 'Jane', html: '', text: '  ' }, HEADER)).toBe(reply);
  });
});
