import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import HelpdeskSettingsPage from './page';

vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

describe('WeldDesk settings page', () => {
  it('says the settings live in the WeldDesk app', () => {
    render(<HelpdeskSettingsPage />);

    expect(screen.getByText(en.settings.welddesk.leavingNotice)).toBeTruthy();
  });

  it('labels each button as a link into the WeldDesk app', () => {
    render(<HelpdeskSettingsPage />);

    const chat = screen.getByRole('link', { name: `${en.settings.welddesk.openInWeldDesk}: ${en.settings.welddesk.chatWidgetTitle}` });
    const email = screen.getByRole('link', { name: `${en.settings.welddesk.openInWeldDesk}: ${en.settings.welddesk.emailTitle}` });
    const help = screen.getByRole('link', { name: `${en.settings.welddesk.openInWeldDesk}: ${en.settings.welddesk.helpCenterTitle}` });

    expect(chat.getAttribute('href')).toBe('/welddesk/chat-widget');
    expect(email.getAttribute('href')).toBe('/welddesk/email');
    expect(help.getAttribute('href')).toBe('/welddesk/help-center');
  });
});
