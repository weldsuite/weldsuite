import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MailThreat } from '@weldsuite/app-api-client/schemas/mail-messages';
import { en } from '@weldsuite/i18n/locales/en';
import { MailThreatBanner } from './mail-threat-banner';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english }) };
});

const copy = en.mail.messageDetail;

describe('MailThreatBanner', () => {
  it('renders nothing without threats', () => {
    const { container } = render(<MailThreatBanner threats={null} />);
    expect(container).toBeEmptyDOMElement();
    render(<MailThreatBanner threats={[]} />);
    expect(screen.queryByTestId('mail-threat-banner')).toBeNull();
  });

  it('warns about a virus and a dangerous link, naming the file and the host', () => {
    const threats: MailThreat[] = [
      { kind: 'attachment', verdict: 'infected', fileName: 'invoice.exe', signature: 'Eicar-Signature' },
      { kind: 'link', verdict: 'malicious', url: 'https://evil.test/login', reason: 'threat_feed' },
    ];
    render(<MailThreatBanner threats={threats} />);
    expect(screen.getByText(copy.threatBannerDanger)).toBeInTheDocument();
    expect(
      screen.getByText(copy.threatBlockedFile.replace('{fileName}', 'invoice.exe').replace('{signature}', 'Eicar-Signature')),
    ).toBeInTheDocument();
    expect(screen.getByText(copy.threatDangerousLink.replace('{host}', 'evil.test'))).toBeInTheDocument();
  });

  it('only cautions when every link is merely suspicious', () => {
    const threats: MailThreat[] = [{ kind: 'link', verdict: 'suspicious', url: 'http://192.0.2.1/x', reason: 'ip_host' }];
    render(<MailThreatBanner threats={threats} />);
    expect(screen.getByText(copy.threatBannerWarning)).toBeInTheDocument();
    expect(screen.getByText(copy.threatSuspiciousLink.replace('{host}', '192.0.2.1'))).toBeInTheDocument();
    expect(screen.queryByText(copy.threatBannerDanger)).toBeNull();
  });
});
