import { describe, expect, it } from 'vitest';
import { screenOutboundContent } from './content-screen';

describe('screenOutboundContent', () => {
  it('scores a cold pitch with a booking link', () => {
    const result = screenOutboundContent({
      subject: 'Quick question',
      text: 'I came across your company. We help companies boost your sales. Would you be open to a 15 minute call? https://calendly.com/tom/intro',
    });
    expect(result.flags.coldOutreach).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.reasons).toContain('booking_link');
  });

  it('flags phishing language and risky attachments', () => {
    const result = screenOutboundContent({
      subject: 'Action required',
      text: 'Your account will be suspended. Verify your account here.',
      attachments: [{ filename: 'invoice.pdf.exe' }],
    });
    expect(result.flags.phishing).toBe(true);
    expect(result.reasons).toContain('risky_attachment');
  });

  it('finds tracking pixels and shorteners in HTML', () => {
    const result = screenOutboundContent({
      html: '<p>Hello</p><a href="https://bit.ly/abc">here</a><img src="https://t.example/p.gif" width="1" height="1">',
    });
    expect(result.reasons).toEqual(expect.arrayContaining(['url_shortener', 'tracking_pixel']));
  });

  it('scores Dutch outreach too', () => {
    const result = screenOutboundContent({
      text: 'Ik zag dat jullie groeien. Wij helpen bedrijven met leads. Zullen we een kort gesprek inplannen, 15 minuten?',
    });
    expect(result.flags.coldOutreach).toBe(true);
  });

  it('leaves an ordinary business reply at zero', () => {
    const result = screenOutboundContent({
      subject: 'Re: Delivery schedule',
      text: 'Thanks Maria, Thursday morning works. I will bring the signed contract.',
    });
    expect(result.score).toBe(0);
    expect(result.flags).toEqual({ coldOutreach: false, bulk: false, phishing: false, links: 0 });
  });
});
