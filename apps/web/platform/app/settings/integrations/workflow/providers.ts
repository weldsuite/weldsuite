/**
 * The providers workflow steps use (`/api/workflow-integrations`, the catalog
 * in `@weldsuite/workflow-integrations`), as Settings → Integrations shows
 * them. Slack, Google Calendar and GitHub have a page of their own that
 * other uses share (the helpdesk channel, the calendar sync, the GitHub App);
 * the rest open the shared workflow provider page under their slug.
 *
 * Only providers whose steps the workflow editor offers are listed
 * (`inEditor`; `WELDCONNECT_ACTION_TYPES` in app/weldconnect/mvp.ts, kept in
 * step by providers.test.ts): connecting one whose steps aren't there yet
 * would do nothing.
 */

import type { TranslationNamespaces } from '@/lib/i18n';
import type { WorkflowIntegration } from '@/hooks/queries/use-workflow-integration-queries';

export type WorkflowProviderCategory = 'Communication' | 'Productivity' | 'Calendar' | 'Developer Tools';

type DescriptionKey = keyof TranslationNamespaces['settings']['integrations']['list']['descriptions'];

export interface WorkflowProviderMeta {
  /** The catalog type (`google_sheets`, `teams`). */
  type: string;
  /** The Settings page under `/settings/integrations/`. */
  slug: string;
  name: string;
  /** Its card's description (`settings.integrations.list.descriptions`). */
  descriptionKey: DescriptionKey;
  category: WorkflowProviderCategory;
  /** The site its favicon comes from. */
  domain: string;
  website: string;
  docs: string;
  /** Has its own Settings page with a workflow section, instead of the shared page. */
  ownPage?: boolean;
  /** The workflow editor offers its steps, so Settings lists it. */
  inEditor: boolean;
}

export const WORKFLOW_PROVIDERS: readonly WorkflowProviderMeta[] = [
  {
    type: 'slack',
    inEditor: true,
    descriptionKey: 'slack',
    slug: 'slack',
    name: 'Slack',
    category: 'Communication',
    domain: 'slack.com',
    website: 'https://slack.com',
    docs: 'https://api.slack.com',
    ownPage: true,
  },
  {
    type: 'gmail',
    inEditor: true,
    descriptionKey: 'gmail',
    slug: 'gmail',
    name: 'Gmail',
    category: 'Communication',
    domain: 'mail.google.com',
    website: 'https://mail.google.com',
    docs: 'https://developers.google.com/gmail/api',
  },
  {
    type: 'teams',
    inEditor: false,
    descriptionKey: 'microsoftTeams',
    slug: 'microsoft-teams',
    name: 'Microsoft Teams',
    category: 'Communication',
    domain: 'teams.microsoft.com',
    website: 'https://www.microsoft.com/microsoft-teams',
    docs: 'https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
  },
  {
    type: 'twilio',
    inEditor: false,
    descriptionKey: 'twilio',
    slug: 'twilio',
    name: 'Twilio',
    category: 'Communication',
    domain: 'twilio.com',
    website: 'https://www.twilio.com',
    docs: 'https://www.twilio.com/docs/usage/api',
  },
  {
    type: 'google_sheets',
    inEditor: true,
    descriptionKey: 'googleSheets',
    slug: 'google-sheets',
    name: 'Google Sheets',
    category: 'Productivity',
    domain: 'sheets.google.com',
    website: 'https://sheets.google.com',
    docs: 'https://developers.google.com/sheets/api',
  },
  {
    type: 'notion',
    inEditor: false,
    descriptionKey: 'notion',
    slug: 'notion',
    name: 'Notion',
    category: 'Productivity',
    domain: 'notion.so',
    website: 'https://www.notion.so',
    docs: 'https://developers.notion.com/docs/create-a-notion-integration',
  },
  {
    type: 'airtable',
    inEditor: false,
    descriptionKey: 'airtable',
    slug: 'airtable',
    name: 'Airtable',
    category: 'Productivity',
    domain: 'airtable.com',
    website: 'https://airtable.com',
    docs: 'https://airtable.com/developers/web/guides/personal-access-tokens',
  },
  {
    type: 'asana',
    inEditor: false,
    descriptionKey: 'asana',
    slug: 'asana',
    name: 'Asana',
    category: 'Productivity',
    domain: 'asana.com',
    website: 'https://asana.com',
    docs: 'https://developers.asana.com/docs/personal-access-token',
  },
  {
    type: 'google_calendar',
    inEditor: true,
    descriptionKey: 'googleCalendar',
    slug: 'google-calendar',
    name: 'Google Calendar',
    category: 'Calendar',
    domain: 'calendar.google.com',
    website: 'https://calendar.google.com',
    docs: 'https://developers.google.com/calendar/api',
    ownPage: true,
  },
  {
    type: 'github',
    inEditor: true,
    descriptionKey: 'github',
    slug: 'github',
    name: 'GitHub',
    category: 'Developer Tools',
    domain: 'github.com',
    website: 'https://github.com',
    docs: 'https://docs.github.com/apps',
    ownPage: true,
  },
];

const BY_TYPE = new Map(WORKFLOW_PROVIDERS.map((provider) => [provider.type, provider]));
const BY_SLUG = new Map(WORKFLOW_PROVIDERS.map((provider) => [provider.slug, provider]));

export function workflowProviderByType(type: string): WorkflowProviderMeta | undefined {
  return BY_TYPE.get(type);
}

/** The providers Settings → Integrations lists: those whose steps the workflow editor offers. */
export const LISTED_WORKFLOW_PROVIDERS: readonly WorkflowProviderMeta[] = WORKFLOW_PROVIDERS.filter(
  (provider) => provider.inEditor,
);

/** A listed provider the shared workflow provider page serves (not Slack, Google Calendar or GitHub). */
export function sharedPageProviderBySlug(slug: string): WorkflowProviderMeta | undefined {
  const provider = BY_SLUG.get(slug);
  return provider && provider.inEditor && !provider.ownPage ? provider : undefined;
}

/** Where a workflow provider is connected: its Settings → Integrations page. */
export function workflowProviderSettingsPath(type: string): string {
  const provider = BY_TYPE.get(type);
  return provider ? `/settings/integrations/${provider.slug}` : '/settings/integrations';
}

/**
 * The newest live connection of a type: a disconnected row stays in the list,
 * and an API-key connect adds a row each time.
 */
export function liveConnection(rows: readonly WorkflowIntegration[], type: string): WorkflowIntegration | undefined {
  return rows
    .filter((row) => row.type === type && row.status === 'connected')
    .sort((a, b) => (b.connectedAt ?? '').localeCompare(a.connectedAt ?? ''))[0];
}

export function workflowProviderIconUrl(provider: WorkflowProviderMeta): string {
  return `https://icons.duckduckgo.com/ip3/${provider.domain}.ico`;
}
