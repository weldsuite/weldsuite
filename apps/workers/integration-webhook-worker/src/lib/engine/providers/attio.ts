/**
 * Attio OAuth + webhook registration provider for the api-worker.
 */

import type { IntegrationOAuthProvider, OAuthTokens, WebhookRegistration } from '../types';

const ATTIO_AUTHORIZE_URL = 'https://app.attio.com/authorize';
const ATTIO_TOKEN_URL = 'https://app.attio.com/oauth/token';
const ATTIO_API_BASE = 'https://api.attio.com/v2';

export class AttioOAuthProvider implements IntegrationOAuthProvider {
  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
    // NOTE: Attio's /authorize accepts only client_id/response_type/redirect_uri/state.
    // Scopes are NOT a query param — they are configured on the OAuth app in the
    // build.attio.com dashboard (records, object configuration, user management,
    // tasks, notes, webhooks). Do NOT add a `scope` param here; Attio ignores it.
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return `${ATTIO_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string
  ): Promise<OAuthTokens> {
    const response = await fetch(ATTIO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio token exchange failed (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async registerWebhooks(
    accessToken: string,
    targetUrl: string
  ): Promise<WebhookRegistration> {
    // Register webhook for record events on people and companies
    const response = await fetch(`${ATTIO_API_BASE}/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          target_url: targetUrl,
          subscriptions: [
            { event_type: 'record.created', filter: null },
            { event_type: 'record.updated', filter: null },
            { event_type: 'record.deleted', filter: null },
            { event_type: 'record.merged', filter: null },
            { event_type: 'note.created', filter: null },
            { event_type: 'note.updated', filter: null },
            { event_type: 'note.deleted', filter: null },
            { event_type: 'task.created', filter: null },
            { event_type: 'task.updated', filter: null },
            { event_type: 'task.deleted', filter: null },
            { event_type: 'list-entry.created', filter: null },
            { event_type: 'list-entry.updated', filter: null },
            { event_type: 'list-entry.deleted', filter: null },
          ],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Attio webhook registration failed (${response.status}): ${errorText}`);
    }

    const responseText = await response.text();
    console.log('[Attio] Webhook registration response:', responseText);

    const data = JSON.parse(responseText) as {
      data: {
        id: { webhook_id: string };
        secret: string;
      };
    };

    return {
      webhookId: data.data.id.webhook_id,
      secret: data.data.secret,
    };
  }

  async deleteWebhooks(accessToken: string, webhookId: string): Promise<void> {
    const response = await fetch(`${ATTIO_API_BASE}/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`Attio webhook deletion failed (${response.status}): ${errorText}`);
    }
  }
}

export const attioOAuthProvider = new AttioOAuthProvider();
