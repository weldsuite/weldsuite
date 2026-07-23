import type { LucideIcon } from 'lucide-react';
import {
  MessageSquare,
  Mail,
  Phone,
  Globe,
  Send,
  MessageCircle,
  Users,
} from 'lucide-react';

type HelpdeskProviderType = 'oauth2' | 'token' | 'wizard';

export type HelpdeskProviderId =
  | 'discord'
  | 'slack'
  | 'teams'
  | 'facebook'
  | 'instagram'
  | 'twitter'
  | 'whatsapp'
  | 'telegram'
  | 'gmail'
  | 'outlook'
  | 'imap';

export interface HelpdeskProviderConfig {
  id: HelpdeskProviderId;
  name: string;
  type: HelpdeskProviderType;
  icon: LucideIcon;
  color: string;
  description: string;
  features: string[];
  // OAuth2 configuration
  scopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  // Environment variable names for credentials
  clientIdEnvVar?: string;
  clientSecretEnvVar?: string;
  // Documentation
  docsUrl?: string;
  // Setup steps shown to user
  setupSteps: string[];
}

/**
 * Helpdesk channel integration provider configurations.
 * Used for OAuth flows and integration setup UI.
 */
export const HELPDESK_PROVIDERS: Record<HelpdeskProviderId, HelpdeskProviderConfig> = {
  discord: {
    id: 'discord',
    name: 'Discord',
    type: 'oauth2',
    icon: MessageCircle,
    color: '#5865F2',
    description: 'Receive and respond to Discord messages from your server',
    features: ['Channel messages', 'Direct messages', 'Message replies', 'Attachments'],
    // identify: get user info, bot: add bot to guild, guilds: see user's guilds
    scopes: ['identify', 'bot', 'guilds'],
    authorizationUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    clientIdEnvVar: 'DISCORD_CLIENT_ID',
    clientSecretEnvVar: 'DISCORD_CLIENT_SECRET',
    docsUrl: 'https://discord.com/developers/docs',
    setupSteps: [
      'Create an Application at discord.com/developers',
      'Add a Bot and enable MESSAGE CONTENT INTENT',
      'Copy Client ID, Secret, and Bot Token to .env',
      'Click "Connect Discord" and select your server',
    ],
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    type: 'oauth2',
    icon: MessageSquare,
    color: '#4A154B',
    description: 'Integrate with Slack workspaces for team and customer support',
    features: ['Channel messages', 'Direct messages', 'Slash commands', 'Workflows'],
    scopes: [
      'channels:history',
      'channels:read',
      'chat:write',
      'im:history',
      'im:read',
      'im:write',
      'users:read',
    ],
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    clientIdEnvVar: 'SLACK_CLIENT_ID',
    clientSecretEnvVar: 'SLACK_CLIENT_SECRET',
    docsUrl: 'https://api.slack.com/docs',
    setupSteps: [
      'Click "Connect Slack" below',
      'Select your Slack workspace',
      'Authorize the required permissions',
      'Start receiving Slack messages in your inbox',
    ],
  },
  teams: {
    id: 'teams',
    name: 'Microsoft Teams',
    type: 'oauth2',
    icon: Users,
    color: '#6264A7',
    description: 'Connect Microsoft Teams for enterprise support',
    features: ['Team channels', 'Direct messages', 'Adaptive cards', 'Bot commands'],
    scopes: [
      'https://graph.microsoft.com/ChannelMessage.Read.All',
      'https://graph.microsoft.com/ChannelMessage.Send',
      'https://graph.microsoft.com/Chat.ReadWrite',
      'https://graph.microsoft.com/User.Read',
    ],
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientIdEnvVar: 'AZURE_AD_CLIENT_ID',
    clientSecretEnvVar: 'AZURE_AD_CLIENT_SECRET',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview',
    setupSteps: [
      'Click "Connect Microsoft Teams" below',
      'Sign in with your Microsoft account',
      'Authorize the required permissions',
      'Start receiving Teams messages in your inbox',
    ],
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook Messenger',
    type: 'oauth2',
    icon: MessageSquare,
    color: '#1877F2',
    description: 'Connect Facebook Messenger for customer support',
    features: ['Page messages', 'Quick replies', 'Persistent menu', 'Handover protocol'],
    scopes: [
      'pages_messaging',
      'pages_read_engagement',
      'pages_manage_metadata',
      'public_profile',
    ],
    authorizationUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    clientIdEnvVar: 'FACEBOOK_APP_ID',
    clientSecretEnvVar: 'FACEBOOK_APP_SECRET',
    docsUrl: 'https://developers.facebook.com/docs/messenger-platform',
    setupSteps: [
      'Click "Connect Facebook" below',
      'Sign in with Facebook',
      'Select the Pages you want to connect',
      'Start receiving Messenger conversations in your inbox',
    ],
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    type: 'oauth2',
    icon: Globe,
    color: '#E4405F',
    description: 'Connect Instagram for DM support',
    features: ['Direct messages', 'Story mentions', 'Comments', 'Quick replies'],
    scopes: [
      'instagram_basic',
      'instagram_manage_messages',
      'pages_messaging',
    ],
    authorizationUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    clientIdEnvVar: 'FACEBOOK_APP_ID',
    clientSecretEnvVar: 'FACEBOOK_APP_SECRET',
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
    setupSteps: [
      'Click "Connect Instagram" below',
      'Sign in with Facebook (Instagram uses Meta login)',
      'Select the Instagram account to connect',
      'Start receiving Instagram DMs in your inbox',
    ],
  },
  twitter: {
    id: 'twitter',
    name: 'Twitter / X',
    type: 'oauth2',
    icon: Globe,
    color: '#1DA1F2',
    description: 'Connect Twitter/X for social support',
    features: ['Direct messages', 'Mentions', 'Quote tweets', 'Replies'],
    scopes: [
      'tweet.read',
      'tweet.write',
      'users.read',
      'dm.read',
      'dm.write',
    ],
    authorizationUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    clientIdEnvVar: 'TWITTER_CLIENT_ID',
    clientSecretEnvVar: 'TWITTER_CLIENT_SECRET',
    docsUrl: 'https://developer.twitter.com/en/docs',
    setupSteps: [
      'Click "Connect Twitter" below',
      'Sign in with your Twitter account',
      'Authorize the required permissions',
      'Start receiving Twitter messages in your inbox',
    ],
  },
  whatsapp: {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    type: 'oauth2',
    icon: Phone,
    color: '#25D366',
    description: 'Connect WhatsApp Business for customer messaging',
    features: ['Business messages', 'Template messages', 'Quick replies', 'Media sharing'],
    scopes: [
      'whatsapp_business_messaging',
      'whatsapp_business_management',
    ],
    authorizationUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    clientIdEnvVar: 'FACEBOOK_APP_ID',
    clientSecretEnvVar: 'FACEBOOK_APP_SECRET',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp',
    setupSteps: [
      'Click "Connect WhatsApp" below',
      'Sign in with your Meta Business account',
      'Select your WhatsApp Business account',
      'Start receiving WhatsApp messages in your inbox',
    ],
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    type: 'token',
    icon: Send,
    color: '#0088CC',
    description: 'Set up a Telegram bot for customer support',
    features: ['Bot messages', 'Group support', 'Inline keyboards', 'Commands'],
    docsUrl: 'https://core.telegram.org/bots',
    setupSteps: [
      'Open Telegram and message @BotFather',
      'Create a new bot with /newbot command',
      'Copy the bot token provided by BotFather',
      'Paste the token below to connect',
    ],
  },
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    type: 'oauth2',
    icon: Mail,
    color: '#EA4335',
    description: 'Connect Gmail for email support',
    features: ['Inbox management', 'Labels', 'Attachments', 'Threads'],
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdEnvVar: 'GOOGLE_CLIENT_ID',
    clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
    docsUrl: 'https://developers.google.com/gmail/api',
    setupSteps: [
      'Click "Connect Gmail" below',
      'Sign in with your Google account',
      'Authorize Gmail access',
      'Start receiving emails in your inbox',
    ],
  },
  outlook: {
    id: 'outlook',
    name: 'Outlook',
    type: 'oauth2',
    icon: Mail,
    color: '#0078D4',
    description: 'Connect Outlook/Microsoft 365 for email support',
    features: ['Inbox management', 'Folders', 'Attachments', 'Threads'],
    scopes: [
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
    ],
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientIdEnvVar: 'AZURE_AD_CLIENT_ID',
    clientSecretEnvVar: 'AZURE_AD_CLIENT_SECRET',
    docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview',
    setupSteps: [
      'Click "Connect Outlook" below',
      'Sign in with your Microsoft account',
      'Authorize email access',
      'Start receiving emails in your inbox',
    ],
  },
  imap: {
    id: 'imap',
    name: 'Email (IMAP)',
    type: 'wizard',
    icon: Mail,
    color: '#6B7280',
    description: 'Connect any email account via IMAP/SMTP',
    features: ['Any email provider', 'Custom domains', 'Full inbox access'],
    docsUrl: 'https://support.google.com/mail/answer/7126229',
    setupSteps: [
      'Enter your email address',
      'Configure IMAP server settings',
      'Configure SMTP server settings',
      'Test connection and start receiving emails',
    ],
  },
};

/**
 * Get provider config by ID
 */
function getHelpdeskProvider(id: string): HelpdeskProviderConfig | undefined {
  return HELPDESK_PROVIDERS[id as HelpdeskProviderId];
}

/**
 * Get all OAuth2 providers
 */
function getOAuthProviders(): HelpdeskProviderConfig[] {
  return Object.values(HELPDESK_PROVIDERS).filter(p => p.type === 'oauth2');
}

/**
 * Get all token-based providers (like Telegram)
 */
function getTokenProviders(): HelpdeskProviderConfig[] {
  return Object.values(HELPDESK_PROVIDERS).filter(p => p.type === 'token');
}

/**
 * Get all wizard-based providers (like IMAP)
 */
function getWizardProviders(): HelpdeskProviderConfig[] {
  return Object.values(HELPDESK_PROVIDERS).filter(p => p.type === 'wizard');
}

/**
 * Map channel type to provider ID
 */
function channelToProvider(channel: string): HelpdeskProviderId | undefined {
  const mapping: Record<string, HelpdeskProviderId> = {
    discord: 'discord',
    slack: 'slack',
    teams: 'teams',
    social: 'facebook', // Social maps to Facebook (also covers Instagram)
    whatsapp: 'whatsapp',
    telegram: 'telegram',
    email: 'gmail', // Email defaults to Gmail
  };
  return mapping[channel];
}
