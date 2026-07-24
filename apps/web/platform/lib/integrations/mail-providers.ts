/**
 * Mail Provider Configuration
 *
 * OAuth2 configuration for Gmail and Outlook email providers.
 * These providers allow users to connect their existing email accounts to WeldSuite.
 */

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
