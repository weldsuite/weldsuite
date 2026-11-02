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

const td = en.settings.welddesk;

describe('WeldDesk settings page', () => {
  it('groups the settings into channels, AI and tickets', () => {
    render(<HelpdeskSettingsPage />);

    expect(screen.getByRole('heading', { name: td.sections.channels })).toBeTruthy();
    expect(screen.getByRole('heading', { name: td.sections.ai })).toBeTruthy();
    expect(screen.getByRole('heading', { name: td.sections.ticketsRouting })).toBeTruthy();
  });

  it('links each setting to its page inside Settings', () => {
    render(<HelpdeskSettingsPage />);

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(hrefs).toEqual([
      '/settings/apps/welddesk/chat-widget',
      '/settings/apps/welddesk/email',
      '/settings/apps/welddesk/phone',
      '/settings/apps/welddesk/help-center',
      '/settings/apps/welddesk/voice-agents',
      '/settings/apps/welddesk/ticket-types',
      '/settings/apps/welddesk/assignment',
    ]);
  });
});
