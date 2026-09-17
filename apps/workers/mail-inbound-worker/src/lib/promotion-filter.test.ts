import { describe, it, expect } from 'vitest';
import {
  PROMOTION_SCORE_THRESHOLD,
  classifyPromotion,
  type PromotionClassifyEmail,
} from './promotion-filter';

function baseEmail(overrides: Partial<PromotionClassifyEmail> = {}): PromotionClassifyEmail {
  return {
    subject: 'Project update',
    textBody: 'Here is the weekly status. Nothing urgent.',
    htmlBody: null,
    headers: {},
    ...overrides,
  };
}

const BULK_HEADERS = {
  'List-Unsubscribe': '<https://shop.example.com/unsub?u=1>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

describe('classifyPromotion', () => {
  it('leaves person-to-person mail alone', () => {
    const result = classifyPromotion(baseEmail());
    expect(result.isPromotion).toBe(false);
    expect(result.score).toBe(0);
  });

  it('classifies a one-click-unsubscribe marketing send', () => {
    const result = classifyPromotion(
      baseEmail({
        subject: 'Summer SALE: 30% off everything',
        textBody: 'Shop now. Unsubscribe here.',
        headers: BULK_HEADERS,
      }),
    );
    expect(result.isPromotion).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['list_unsubscribe', 'list_unsubscribe_post', 'subject_marketing', 'body_unsubscribe']),
    );
  });

  it('classifies a Dutch newsletter via ESP campaign headers', () => {
    const result = classifyPromotion(
      baseEmail({
        subject: 'Onze nieuwsbrief van september',
        textBody: 'Klik hier om je af te melden: afmelden',
        headers: { 'X-Mailin-Campaign': '42' },
      }),
    );
    expect(result.isPromotion).toBe(true);
  });

  it('does not classify on marketing words alone', () => {
    const result = classifyPromotion(
      baseEmail({ subject: 'Deal update for Acme', textBody: 'Can we discuss the discount?' }),
    );
    expect(result.score).toBeLessThan(PROMOTION_SCORE_THRESHOLD);
    expect(result.isPromotion).toBe(false);
  });

  it('keeps transactional mail from a bulk sender out of promotions', () => {
    const result = classifyPromotion(
      baseEmail({
        subject: 'Your order confirmation #1234',
        textBody: 'Thanks for your purchase. Unsubscribe from marketing.',
        headers: { ...BULK_HEADERS, Precedence: 'bulk' },
      }),
    );
    expect(result.reasons).toContain('subject_transactional');
    expect(result.isPromotion).toBe(false);
  });

  it('never classifies a reply', () => {
    const result = classifyPromotion(
      baseEmail({ subject: 'Re: 50% off', headers: BULK_HEADERS }),
      { isReply: true },
    );
    expect(result.isPromotion).toBe(false);
  });

  it('matches whole words only', () => {
    const result = classifyPromotion(
      baseEmail({ subject: 'Wholesale pricing from Salesforce', headers: { 'List-Unsubscribe': '<mailto:x@y.z>' } }),
    );
    expect(result.reasons).not.toContain('subject_marketing');
    expect(result.isPromotion).toBe(false);
  });

  it('reads headers case-insensitively', () => {
    const result = classifyPromotion(
      baseEmail({
        subject: 'Black Friday deals',
        headers: { 'list-unsubscribe': '<mailto:u@x.com>', precedence: 'Bulk' },
      }),
    );
    expect(result.isPromotion).toBe(true);
  });
});
