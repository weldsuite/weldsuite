/**
 * Integration provider interface for the api-worker side.
 * Handles OAuth flow and webhook registration.
 */

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
}

export interface WebhookRegistration {
  webhookId: string;
  secret: string;
}

export interface IntegrationOAuthProvider {
  /** Build the OAuth authorization URL. */
  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string;

  /** Exchange an authorization code for tokens. */
  exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string
  ): Promise<OAuthTokens>;

  /** Register webhooks at the provider, pointing to our webhook worker. */
  registerWebhooks(
    accessToken: string,
    targetUrl: string
  ): Promise<WebhookRegistration>;

  /** Delete webhooks at the provider. */
  deleteWebhooks(accessToken: string, webhookId: string): Promise<void>;
}
