import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ href, onClick, children }: { href: string; onClick?: () => void; children: React.ReactNode }) => (
    <a href={href} onClick={(event) => { event.preventDefault(); onClick?.(); }}>{children}</a>
  ),
}));
const desk = vi.hoisted(() => ({ installed: true }));
vi.mock('@/hooks/use-app-access', () => ({ useAppAccess: () => ({ isInstalled: desk.installed, isLoading: false }) }));
vi.mock('@/app/welddesk/settings/integrations/slack/helpdesk-slack-section', () => ({
  HelpdeskSlackSection: () => <p>helpdesk channel</p>,
}));
vi.mock('../workflow/workflow-connection-section', () => ({
  WorkflowConnectionSection: ({ type }: { type: string }) => <p>workflow actions for {type}</p>,
}));

import { en } from '@weldsuite/i18n/locales/en';
import { setRuntimeConfig } from '@/lib/runtime-config';
import SlackIntegrationPage from './page';
import { IntegrationSettingsLink } from '../workflow/integration-settings-link';

afterEach(() => {
  setRuntimeConfig(null);
  desk.installed = true;
  sessionStorage.clear();
});

describe('Settings → Integrations → Slack', () => {
  it('shows the helpdesk channel and the workflow actions on Global', () => {
    render(<SlackIntegrationPage />);
    expect(screen.getByRole('heading', { name: 'Slack' })).toBeInTheDocument();
    expect(screen.getByText(en.settings.integrations.slackPage.overview)).toBeInTheDocument();
    expect(screen.getByText('helpdesk channel')).toBeInTheDocument();
    expect(screen.getByText('workflow actions for slack')).toBeInTheDocument();
  });

  it('leaves out the helpdesk channel where WeldDesk is not installed', () => {
    desk.installed = false;
    render(<SlackIntegrationPage />);
    expect(screen.queryByText('helpdesk channel')).toBeNull();
    expect(screen.getByText('workflow actions for slack')).toBeInTheDocument();
  });

  it('leaves out the helpdesk channel where the edition lacks integration-sync', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'desk'], unavailableFeatures: ['integration-sync'] });
    render(<SlackIntegrationPage />);
    expect(screen.queryByText('helpdesk channel')).toBeNull();
    expect(screen.getByText('workflow actions for slack')).toBeInTheDocument();
  });
});

describe('IntegrationSettingsLink', () => {
  it("opens the provider's Settings page and remembers where you came from", () => {
    window.history.pushState({}, '', '/w/acme/weldconnect/workflows/wf_1');
    render(<IntegrationSettingsLink provider="google_sheets">Connect</IntegrationSettingsLink>);
    const link = screen.getByRole('link', { name: 'Connect' });
    expect(link).toHaveAttribute('href', '/settings/integrations/google-sheets');
    fireEvent.click(link);
    expect(sessionStorage.getItem('settings-return-url')).toBe('/weldconnect/workflows/wf_1');
  });

  it('opens the integrations list without a provider', () => {
    render(<IntegrationSettingsLink>Integrations</IntegrationSettingsLink>);
    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/settings/integrations');
  });
});
