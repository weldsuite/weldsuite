import { describe, it, expect } from 'vitest';
import {
  SPAM_SCORE_THRESHOLD,
  scoreInboundSpam,
  type SpamScoreEmail,
} from './spam-filter';

function baseEmail(overrides: Partial<SpamScoreEmail> = {}): SpamScoreEmail {
  return {
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'me@weldmail.com' }],
    subject: 'Project update',
    textBody: 'Here is the weekly status. Nothing urgent.',
    htmlBody: null,
    headers: {},
    spfStatus: 'pass',
    dkimStatus: 'pass',
    dmarcStatus: 'pass',
    ...overrides,
  };
}

describe('scoreInboundSpam', () => {
  it('scores clean authenticated mail as ham', () => {
    const result = scoreInboundSpam(baseEmail());
    expect(result.isSpam).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('stacks auth failures into spam', () => {
    const result = scoreInboundSpam(
      baseEmail({
        spfStatus: 'fail',
        dkimStatus: 'fail',
        dmarcStatus: 'fail',
      }),
    );
    // dmarc 3 + spf 2 + dkim 2 + all_fail 2 = 9
    expect(result.score).toBe(9);
    expect(result.isSpam).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['dmarc_fail', 'spf_fail', 'dkim_fail', 'auth_all_fail']),
    );
  });

  it('adds a weak signal when all auth is missing', () => {
    const result = scoreInboundSpam(
      baseEmail({
        spfStatus: undefined,
        dkimStatus: undefined,
        dmarcStatus: undefined,
      }),
    );
    expect(result.score).toBe(1);
    expect(result.reasons).toContain('auth_all_missing');
    expect(result.isSpam).toBe(false);
  });

  it('flags executable attachments', () => {
    const result = scoreInboundSpam(baseEmail(), {
      attachmentNames: ['invoice.pdf', 'payload.exe'],
    });
    expect(result.score).toBe(4);
    expect(result.reasons).toContain('executable_attachment');
    expect(result.isSpam).toBe(false); // below threshold alone
  });

  it('flags spam lexicon in subject', () => {
    const result = scoreInboundSpam(
      baseEmail({ subject: 'You won the lottery jackpot!!!' }),
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining(['subject_spam_lexicon', 'subject_shouting']),
    );
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it('flags display-name spoof against recipient domain', () => {
    const result = scoreInboundSpam(
      baseEmail({
        from: { email: 'evil@phish.example', name: 'support@weldmail.com' },
      }),
      { recipientEmails: ['me@weldmail.com'] },
    );
    expect(result.reasons).toContain('from_display_spoof');
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it('flags reply-to domain mismatch', () => {
    const result = scoreInboundSpam(
      baseEmail({
        headers: { 'Reply-To': 'collector@evil.example' },
      }),
    );
    expect(result.reasons).toContain('reply_to_domain_mismatch');
    expect(result.score).toBe(1);
  });

  it('combines signals over the spam threshold', () => {
    const result = scoreInboundSpam(
      baseEmail({
        subject: 'CLAIM YOUR PRIZE NOW!!!',
        spfStatus: 'fail',
        dkimStatus: 'none',
        dmarcStatus: 'none',
        textBody: 'http://a.com http://b.com http://c.com http://d.com http://e.com click',
      }),
      { attachmentNames: ['update.js'] },
    );
    expect(result.isSpam).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(SPAM_SCORE_THRESHOLD);
  });

  it('caps score for existing ham thread continuations', () => {
    const result = scoreInboundSpam(
      baseEmail({
        spfStatus: 'fail',
        dkimStatus: 'fail',
        dmarcStatus: 'fail',
        subject: 'URGENT WIRE TRANSFER!!!',
      }),
      { isExistingHamThread: true },
    );
    expect(result.score).toBe(SPAM_SCORE_THRESHOLD - 1);
    expect(result.isSpam).toBe(false);
    expect(result.reasons).toContain('capped_existing_ham_thread');
  });

  it('does not cap when already below threshold', () => {
    const result = scoreInboundSpam(baseEmail({ spfStatus: 'softfail' }), {
      isExistingHamThread: true,
    });
    expect(result.score).toBe(2);
    expect(result.reasons).not.toContain('capped_existing_ham_thread');
  });
});
