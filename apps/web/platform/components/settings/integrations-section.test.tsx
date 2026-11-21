import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { idle } = vi.hoisted(() => ({ idle: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/queries/use-integration-queries', () => ({ useIntegrationConnections: idle }));
vi.mock('@/hooks/queries/use-helpdesk-integration-queries', () => ({ useChannelIntegrations: idle }));
vi.mock('@/hooks/queries/use-github-queries', () => ({ useGithubConnection: idle }));
vi.mock('@/hooks/queries/use-connector-queries', () => ({ useConnectorCatalog: idle }));

import { setRuntimeConfig } from '@/lib/runtime-config';
import { IntegrationsSection } from './integrations-section';

const ALL = ['Attio', 'Salesforce', 'HubSpot', 'Discord', 'Slack', 'MCP Servers', 'Google Calendar', 'GitHub', 'WooCommerce', 'Shopify', 'Moneybird', 'Picqer'];

function shown(): string[] {
  return ALL.filter((name) => screen.queryByText(name, { selector: 'span' }) !== null);
}

afterEach(() => setRuntimeConfig(null));

describe('IntegrationsSection', () => {
  it('lists every integration on Global', () => {
    render(<IntegrationsSection />);
    expect(shown()).toEqual(ALL);
  });

  it('lists only the store syncs on a Kubernetes edition without integration-sync', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect'], unavailableFeatures: ['integration-sync'] });
    render(<IntegrationsSection />);
    expect(shown()).toEqual(['WooCommerce', 'Shopify']);
  });

  it('adds MCP servers where WeldAgent is served', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect', 'agent'], unavailableFeatures: ['integration-sync'] });
    render(<IntegrationsSection />);
    expect(shown()).toEqual(['MCP Servers', 'WooCommerce', 'Shopify']);
  });
});
