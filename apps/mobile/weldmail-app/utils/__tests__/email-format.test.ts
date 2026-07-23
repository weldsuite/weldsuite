import {
  getSenderName,
  getSenderEmail,
  formatRecipients,
  formatFileSize,
  formatMessageDate,
  buildComposeParams,
} from '../email-format';

describe('getSenderName', () => {
  it('falls back when there is no sender', () => {
    expect(getSenderName(null)).toBe('(No sender)');
    expect(getSenderName(undefined)).toBe('(No sender)');
    expect(getSenderName({})).toBe('(No sender)');
  });
  it('returns a string sender as-is', () => {
    expect(getSenderName('Ada <ada@x.com>')).toBe('Ada <ada@x.com>');
  });
  it('prefers name, then email', () => {
    expect(getSenderName({ name: 'Ada', email: 'ada@x.com' })).toBe('Ada');
    expect(getSenderName({ email: 'ada@x.com' })).toBe('ada@x.com');
  });
});

describe('getSenderEmail', () => {
  it('returns empty when missing', () => {
    expect(getSenderEmail(null)).toBe('');
    expect(getSenderEmail({})).toBe('');
  });
  it('returns the email from object or string', () => {
    expect(getSenderEmail({ email: 'a@b.com' })).toBe('a@b.com');
    expect(getSenderEmail('a@b.com')).toBe('a@b.com');
  });
});

describe('formatRecipients', () => {
  it('handles empty / string / array / object', () => {
    expect(formatRecipients(null)).toBe('');
    expect(formatRecipients('a@b.com, c@d.com')).toBe('a@b.com, c@d.com');
    expect(formatRecipients([{ name: 'A' }, { email: 'b@x.com' }, 'c@x.com'])).toBe('A, b@x.com, c@x.com');
    expect(formatRecipients({ email: 'solo@x.com' })).toBe('solo@x.com');
  });
  it('drops empties when joining an array', () => {
    expect(formatRecipients([{ name: 'A' }, {}, 'c@x.com'])).toBe('A, c@x.com');
  });
});

describe('formatFileSize', () => {
  it('formats bytes across units', () => {
    expect(formatFileSize(0)).toBe('0 Bytes');
    expect(formatFileSize(512)).toBe('512 Bytes');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1048576)).toBe('1 MB');
  });
});

describe('formatMessageDate', () => {
  it('returns empty for missing / invalid dates', () => {
    expect(formatMessageDate(undefined)).toBe('');
    expect(formatMessageDate('not-a-date')).toBe('');
  });
  it('shows HH:mm for today and "D Mon" for other days', () => {
    const now = new Date();
    const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).toISOString();
    expect(formatMessageDate(todayAt)).toMatch(/^\d{2}:\d{2}$/);
    // A fixed past date is never "today".
    expect(formatMessageDate('2020-03-15T14:30:00')).toMatch(/^15 Mar$/);
  });
});

describe('buildComposeParams', () => {
  const msg = {
    from: { name: 'Ada', email: 'ada@x.com' },
    cc: 'c@x.com',
    subject: 'Hello',
    textBody: 'hi there',
    sentDate: '2020-01-01',
    emailAccountId: 'acc_1',
  };

  it('builds a reply prefill (to sender, Re: subject, quoted body)', () => {
    const p = buildComposeParams(msg, 'reply');
    expect(p.mode).toBe('reply');
    expect(p.replyTo).toBe('ada@x.com');
    expect(p.replyCc).toBe('');
    expect(p.subject).toBe('Re: Hello');
    expect(p.quotedFrom).toBe('Ada (ada@x.com)');
    expect(p.quotedBody).toBe('hi there');
    expect(p.emailAccountId).toBe('acc_1');
  });

  it('includes cc on reply-all', () => {
    expect(buildComposeParams(msg, 'replyAll').replyCc).toBe('c@x.com');
  });

  it('uses Fwd: and no replyTo on forward', () => {
    const p = buildComposeParams(msg, 'forward');
    expect(p.subject).toBe('Fwd: Hello');
    expect(p.replyTo).toBe('');
  });

  it('does not double-prefix an existing Re:/Fwd: subject', () => {
    expect(buildComposeParams({ ...msg, subject: 'Re: Hello' }, 'reply').subject).toBe('Re: Hello');
    expect(buildComposeParams({ ...msg, subject: 'Fwd: Hello' }, 'forward').subject).toBe('Fwd: Hello');
  });

  it('falls back to the provided account id when the message has none', () => {
    expect(
      buildComposeParams({ from: 'x', subject: 's' }, 'reply', 'fallback_acc').emailAccountId,
    ).toBe('fallback_acc');
  });
});
