/**
 * WeldDesk channel integrations (Discord / Slack support channels).
 *
 * Backed by app-api `/api/helpdesk-integrations/*` (W5b of the legacy-worker
 * phase-out ported apps/api-worker/src/routes/helpdesk/integrations.ts over).
 *
 * This surface reads and writes `helpdeskChannelIntegrations`. Do NOT point it
 * at `/api/integrations` — that route serves `integrationConnections`
 * (Attio/HubSpot/Google Calendar/MCP). They are different tables; crossing them
 * would silently corrupt both feature sets.
 *
 * ENVELOPES: app-api answers `{ data: T }`. Hooks below unwrap to `T` because
 * their consumers read the payload directly (`integration.status`,
 * `result.channels`, `result.messageId`, …). The one exception is
 * `useChannelIntegrations`, whose consumer
 * (components/settings/integrations-section.tsx) reads
 * `result?.data?.integrations` — so it deliberately returns the raw envelope.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

/** app-api single-resource envelope. */
interface Envelope<T> {
  data: T;
}

/** True for the ApiError thrown on a 404 response. */
function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404;
}

// =============================================================================
// Query Keys
// =============================================================================

const helpdeskIntegrationKeys = {
  all: ['helpdesk', 'integrations'] as const,
  lists: () => [...helpdeskIntegrationKeys.all, 'list'] as const,
  channelStatus: (provider: string) => [...helpdeskIntegrationKeys.all, 'channel-status', provider] as const,
  discordSettings: () => [...helpdeskIntegrationKeys.all, 'discord-settings'] as const,
  discordChannels: () => [...helpdeskIntegrationKeys.all, 'discord-channels'] as const,
};

// =============================================================================
// Queries
// =============================================================================

/** Raw envelope — consumers read `result?.data?.integrations`. */
export function useChannelIntegrations() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskIntegrationKeys.lists(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<Envelope<Helpdesk.Api.ChannelIntegrationsResponse>>('/helpdesk-integrations');
    },
  });
}

export function useChannelIntegrationStatus(provider: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskIntegrationKeys.channelStatus(provider),
    queryFn: async () => {
      const client = await getClient();
      try {
        const res = await client.get<Envelope<Helpdesk.Api.ChannelIntegration>>(
          `/helpdesk-integrations/${provider}`,
        );
        return res?.data ?? null;
      } catch (err) {
        // Never connected — a null result, not a failure.
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    enabled: !!provider && enabled,
  });
}

export function useDiscordSettings(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskIntegrationKeys.discordSettings(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<Envelope<Helpdesk.Api.DiscordIntegrationSettings>>(
        '/helpdesk-integrations/discord/settings',
      );
      return res.data;
    },
    enabled,
  });
}

export function useDiscordChannels(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: helpdeskIntegrationKeys.discordChannels(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<Envelope<Helpdesk.Api.DiscordGuildInfo>>(
        '/helpdesk-integrations/discord/channels',
      );
      return res.data;
    },
    enabled,
  });
}

export function useSlackSettings(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...helpdeskIntegrationKeys.all, 'slack', 'settings'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<Envelope<Helpdesk.Api.SlackIntegrationSettings>>(
        '/helpdesk-integrations/slack/settings',
      );
      return res.data;
    },
    enabled,
  });
}

export function useSlackChannels(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: [...helpdeskIntegrationKeys.all, 'slack', 'channels'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<Envelope<Helpdesk.Api.SlackWorkspaceInfo>>(
        '/helpdesk-integrations/slack/channels',
      );
      return res.data;
    },
    enabled,
  });
}

export function useUpdateSlackSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Helpdesk.Api.UpdateSlackSettingsRequest) => {
      const client = await getClient();
      const res = await client.put<Envelope<Helpdesk.Api.SlackIntegrationSettings>>(
        '/helpdesk-integrations/slack/settings',
        data,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...helpdeskIntegrationKeys.all, 'slack'] });
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Start the provider OAuth dance. app-api mints the state nonce (it needs the
 * Clerk JWT to bind the nonce to the workspace) and hands back the authorize
 * URL for the browser to follow.
 */
export function useConnectChannelOAuth() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      const client = await getClient();
      const res = await client.post<Envelope<{ authUrl: string }>>(
        `/helpdesk-integrations/${provider}/connect`,
      );
      return res.data;
    },
  });
}

/** Accepts an integration id or a provider name. */
export function useDisconnectChannel() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (integrationIdOrProvider: string) => {
      const client = await getClient();
      await client.delete<Envelope<{ message: string }>>(
        `/helpdesk-integrations/${integrationIdOrProvider}`,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskIntegrationKeys.all });
    },
  });
}

export function useSaveTokenIntegration() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider, token, config }: {
      provider: string;
      token: string;
      config?: Record<string, unknown>;
    }) => {
      const client = await getClient();
      const res = await client.post<Envelope<Helpdesk.Api.ChannelIntegration>>(
        '/helpdesk-integrations/token',
        { provider, token, config },
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskIntegrationKeys.all });
    },
  });
}

export function useTestChannelConnection() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (provider: string) => {
      const client = await getClient();
      const res = await client.post<Envelope<Helpdesk.Api.TestChannelConnectionResponse>>(
        `/helpdesk-integrations/${provider}/test`,
      );
      return res.data;
    },
  });
}

export function useRefreshChannelToken() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (integrationId: string) => {
      const client = await getClient();
      const res = await client.post<Envelope<Helpdesk.Api.ChannelIntegration>>(
        `/helpdesk-integrations/${integrationId}/refresh`,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskIntegrationKeys.all });
    },
  });
}

export function useUpdateDiscordSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Helpdesk.Api.UpdateDiscordSettingsRequest) => {
      const client = await getClient();
      const res = await client.put<Envelope<Helpdesk.Api.DiscordIntegrationSettings>>(
        '/helpdesk-integrations/discord/settings',
        data,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskIntegrationKeys.discordSettings() });
      qc.invalidateQueries({ queryKey: helpdeskIntegrationKeys.discordChannels() });
    },
  });
}

export function usePostTicketPanel() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Helpdesk.Api.PostDiscordTicketPanelRequest) => {
      const client = await getClient();
      const res = await client.post<Envelope<Helpdesk.Api.PostDiscordTicketPanelResponse>>(
        '/helpdesk-integrations/discord/ticket-panel',
        data,
      );
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: helpdeskIntegrationKeys.discordSettings() });
    },
  });
}
