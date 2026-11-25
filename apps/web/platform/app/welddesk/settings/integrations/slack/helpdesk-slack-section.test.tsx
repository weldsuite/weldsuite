import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));

const { toast, router, params, slack } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  router: { replace: vi.fn() },
  params: { value: new URLSearchParams() },
  slack: {
    status: 'disconnected',
    authUrl: 'https://slack.com/oauth/v2/authorize?x=1' as string | null,
    connectFails: false,
    disconnectFails: false,
    disconnected: [] as string[],
  },
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/router', () => ({ useRouter: () => router, useSearchParams: () => params.value }));
vi.mock('./slack-settings-client', () => ({ SlackSettingsClient: () => <p>slack channel settings</p> }));
vi.mock('@/hooks/queries/use-helpdesk-integration-queries', () => ({
  useChannelIntegrationStatus: () => ({ data: { id: 'ci_1', status: slack.status }, isLoading: false }),
  useSlackSettings: () => ({ data: {}, isLoading: false }),
  useSlackChannels: () => ({ data: { channels: [] }, isLoading: false }),
  useConnectChannelOAuth: () => ({
    mutateAsync: async () => {
      if (slack.connectFails) throw new Error('slack down');
      return { authUrl: slack.authUrl };
    },
  }),
  useDisconnectChannel: () => ({
    isPending: false,
    mutateAsync: async (id: string) => {
      if (slack.disconnectFails) throw new Error('nope');
      slack.disconnected.push(id);
    },
  }),
}));

import { en } from '@weldsuite/i18n/locales/en';
import { HelpdeskSlackSection } from './helpdesk-slack-section';

const desk = en.helpdesk.integrationSettings;

afterEach(() => {
  params.value = new URLSearchParams();
  slack.status = 'disconnected';
  slack.authUrl = 'https://slack.com/oauth/v2/authorize?x=1';
  slack.connectFails = false;
  slack.disconnectFails = false;
  slack.disconnected = [];
  vi.clearAllMocks();
});

describe('HelpdeskSlackSection', () => {
  it('starts the helpdesk OAuth flow at Slack', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, set href(url: string) { assign(url); } } });
    render(<HelpdeskSlackSection />);
    expect(screen.getByRole('heading', { name: en.settings.integrations.slackPage.helpdeskTitle })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sweep.welddesk.slackIntegration.connectLabel' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?x=1'));
  });

  it('says when Slack gives no URL to go to, or the start fails', async () => {
    slack.authUrl = null;
    render(<HelpdeskSlackSection />);
    fireEvent.click(screen.getByRole('button', { name: 'sweep.welddesk.slackIntegration.connectLabel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(desk.noAuthUrl));
    slack.connectFails = true;
    fireEvent.click(screen.getByRole('button', { name: 'sweep.welddesk.slackIntegration.connectLabel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('sweep.welddesk.slackIntegration.oauthStartFailed'));
  });

  it("shows the channel's settings once connected, and disconnects after confirming", async () => {
    slack.status = 'connected';
    render(<HelpdeskSlackSection />);
    expect(screen.getByText('slack channel settings')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sweep.settings.integrationConnectionCard.disconnect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'sweep.welddesk.slackIntegration.disconnectConfirmLabel' }));
    await waitFor(() => expect(slack.disconnected).toEqual(['ci_1']));
    expect(toast.success).toHaveBeenCalledWith(desk.slackDisconnected);
  });

  it('says when the disconnect fails', async () => {
    slack.status = 'connected';
    slack.disconnectFails = true;
    render(<HelpdeskSlackSection />);
    fireEvent.click(screen.getByRole('button', { name: 'sweep.settings.integrationConnectionCard.disconnect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'sweep.welddesk.slackIntegration.disconnectConfirmLabel' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(desk.failedToDisconnectSlack));
  });

  it("reads Slack's return and clears it from the address", () => {
    params.value = new URLSearchParams('connected=true');
    const { unmount } = render(<HelpdeskSlackSection />);
    expect(toast.success).toHaveBeenCalledWith(desk.slackConnected);
    expect(router.replace).toHaveBeenCalledWith('/settings/integrations/slack');
    unmount();
    params.value = new URLSearchParams('error=access_denied');
    render(<HelpdeskSlackSection />);
    expect(toast.error).toHaveBeenCalledWith('sweep.welddesk.slackIntegration.connectionFailed');
  });
});
