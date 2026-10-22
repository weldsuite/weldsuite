/**
 * A mail with a subject but no body (no text, no html) must still render.
 * mimetext throws MIMETEXT_MISSING_BODY when a message has no body part; the
 * builder adds an empty text/plain part so such a send is valid.
 */

import { describe, it, expect } from 'vitest';
import { buildRfc5322 } from '@weldsuite/email/core/mime';

const base = {
  from: { email: 'sender@test.dev' },
  to: [{ email: 'rcpt@example.com' }],
  subject: 'Subject only',
};

describe('buildRfc5322 · empty body', () => {
  it('renders a message with neither text nor html', () => {
    const { raw, messageId } = buildRfc5322(base);
    expect(raw).toContain('rcpt@example.com');
    expect(raw).toContain('Content-Type: text/plain');
    expect(messageId).toMatch(/^<.+@test\.dev>$/);
  });

  it('renders a message with empty strings for text and html', () => {
    expect(() => buildRfc5322({ ...base, text: '', html: '' })).not.toThrow();
  });

  it('does not add an extra part when a body is present', () => {
    const { raw } = buildRfc5322({ ...base, text: 'Hello there' });
    expect(raw).toContain('Hello there');
    expect(raw.match(/Content-Type: text\/plain/g)).toHaveLength(1);
  });
});
