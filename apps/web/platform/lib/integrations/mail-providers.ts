/**
 * Mail Provider Configuration
 *
 * OAuth2 configuration for Gmail and Outlook email providers.
 * These providers allow users to connect their existing email accounts to WeldSuite.
 */

type MailProvider = 'gmail' | 'outlook' | 'office365' | 'resend';

interface MailProviderConfig {
  id: MailProvider;
  name: string;
  icon: string;
  color: string;
  authType: 'oauth2' | 'password';
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  userInfoUrl?: string;
  scopeSeparator?: string;
}

/**
 * Gmail OAuth2 scopes:
 * - gmail.readonly: Read emails
 * - gmail.send: Send emails
 * - gmail.modify: Modify labels, mark read/unread
 * - userinfo.email: Get user email address
 * - userinfo.profile: Get user profile info
 */
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/**
 * Microsoft Graph OAuth2 scopes:
 * - Mail.ReadWrite: Read and write mail
 * - Mail.Send: Send mail
 * - User.Read: Read user profile
 * - offline_access: Get refresh token for long-lived access
 */
const OUTLOOK_SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];

const MAIL_PROVIDERS: Record<string, MailProviderConfig> = {
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    icon: 'gmail',
    color: '#EA4335',
    authType: 'oauth2',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: GMAIL_SCOPES,
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopeSeparator: ' ',
  },
  outlook: {
    id: 'outlook',
    name: 'Outlook',
    icon: 'outlook',
    color: '#0078D4',
    authType: 'oauth2',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: OUTLOOK_SCOPES,
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scopeSeparator: ' ',
  },
  office365: {
    id: 'office365',
    name: 'Office 365',
    icon: 'microsoft',
    color: '#0078D4',
    authType: 'oauth2',
    // Uses same endpoints as outlook but can be configured with specific tenant
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: OUTLOOK_SCOPES,
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scopeSeparator: ' ',
  },
  resend: {
    id: 'resend',
    name: 'WeldSuite Mail',
    icon: 'mail',
    color: '#6366F1',
    authType: 'api_key',
  },
} as const;

/**
 * Get provider configuration by ID
 */
function getMailProvider(providerId: string): MailProviderConfig | null {
  return MAIL_PROVIDERS[providerId] || null;
}

/**
 * Check if a provider supports OAuth2
 */
function isOAuthProvider(providerId: string): boolean {
  const provider = getMailProvider(providerId);
  return provider?.authType === 'oauth2';
}

/**
 * Get OAuth providers only (for connection UI)
 */
function getOAuthMailProviders(): MailProviderConfig[] {
  return Object.values(MAIL_PROVIDERS).filter((p) => p.authType === 'oauth2');
}

/**
 * Build OAuth authorization URL for a provider
 */
function buildAuthUrl(
  providerId: string,
  params: {
    clientId: string;
    redirectUri: string;
    state: string;
    tenant?: string; // For Azure AD tenant-specific auth
  }
): string | null {
  const provider = getMailProvider(providerId);
  if (!provider || provider.authType !== 'oauth2' || !provider.authUrl) {
    return null;
  }

  let authUrl = provider.authUrl;

  // Replace tenant placeholder for Azure AD
  if (params.tenant && authUrl.includes('{tenant}')) {
    authUrl = authUrl.replace('{tenant}', params.tenant);
  }

  const url = new URL(authUrl);

  // Common OAuth2 parameters
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);

  if (provider.scopes) {
    url.searchParams.set('scope', provider.scopes.join(provider.scopeSeparator || ' '));
  }

  // Provider-specific parameters
  if (providerId === 'gmail') {
    // Gmail-specific: request offline access for refresh token
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent'); // Force consent to always get refresh token
  } else if (providerId === 'outlook' || providerId === 'office365') {
    // Microsoft-specific
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('response_mode', 'query');
  }

  return url.toString();
}

/**
 * Environment variable names for each provider
 */
const PROVIDER_ENV_VARS = {
  gmail: {
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    pubsubTopic: 'GOOGLE_PUBSUB_TOPIC',
  },
  outlook: {
    clientId: 'AZURE_CLIENT_ID',
    clientSecret: 'AZURE_CLIENT_SECRET',
    tenantId: 'AZURE_TENANT_ID',
  },
  office365: {
    clientId: 'AZURE_CLIENT_ID',
    clientSecret: 'AZURE_CLIENT_SECRET',
    tenantId: 'AZURE_TENANT_ID',
  },
} as const;

/**
 * Get environment variables for a provider
 */
export function getProviderCredentials(providerId: string): {
  clientId: string | undefined;
  clientSecret: string | undefined;
  tenantId?: string;
} {
  const envVars = PROVIDER_ENV_VARS[providerId as keyof typeof PROVIDER_ENV_VARS];
  if (!envVars) {
    return { clientId: undefined, clientSecret: undefined };
  }

  return {
    clientId: process.env[envVars.clientId],
    clientSecret: process.env[envVars.clientSecret],
    tenantId: 'tenantId' in envVars ? process.env[envVars.tenantId] : undefined,
  };
}
