import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const { idle } = vi.hoisted(() => ({ idle: () => ({ data: undefined, isLoading: false }) }));
vi.mock('@/hooks/queries/use-integration-queries', () => ({ useIntegrationConnections: idle }));
vi.mock('@/hooks/queries/use-helpdesk-integration-queries', () => ({ useChannelIntegrations: idle }));
vi.mock('@/hooks/queries/use-github-queries', () => ({ useGithubConnection: idle }));
vi.mock('@/hooks/queries/use-connector-queries', () => ({ useConnectorCatalog: idle }));
// The EU edition's outside-EU state (ADR OPS-026): the labels read it; Global never asks.
const outsideEu = vi.hoisted(() => ({ data: undefined as OutsideEuServices | undefined, asked: 0 }));
vi.mock('@/hooks/queries/use-outside-eu-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/queries/use-outside-eu-queries')>();
  const state = () => {
    outsideEu.asked += 1;
    return outsideEu.data;
  };
  return {
    ...actual,
    useOutsideEuServices: () => ({ data: state() }),
    useOutsideEuServiceFor: (code: string) => {
      const data = state();
      return data?.enforced ? actual.outsideEuServiceFor(data, code) : null;
    },
  };
});

import type { OutsideEuServices } from '@weldsuite/app-api-client/schemas/outside-eu-services';
import { setRuntimeConfig } from '@/lib/runtime-config';
import { IntegrationsSection } from './integrations-section';

const ALL = ['Attio', 'Salesforce', 'HubSpot', 'Discord', 'Slack', 'MCP Servers', 'Google Calendar', 'GitHub', 'WooCommerce', 'Shopify', 'Moneybird', 'Picqer'];

function shown(): string[] {
  return ALL.filter((name) => screen.queryByText(name, { selector: 'span' }) !== null);
}

afterEach(() => {
  setRuntimeConfig(null);
  outsideEu.data = undefined;
  outsideEu.asked = 0;
});

describe('IntegrationsSection', () => {
  it('lists every integration on Global', () => {
    render(<IntegrationsSection />);
    expect(shown()).toEqual(ALL);
    // Global has no outside-EU switches: nothing is asked, nothing is labelled.
    expect(outsideEu.asked).toBe(0);
    expect(screen.queryByText('Leaves the EU')).toBeNull();
  });

  it('lists only the store and accounting connectors on a Kubernetes edition without integration-sync', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect'], unavailableFeatures: ['integration-sync'] });
    render(<IntegrationsSection />);
    expect(shown()).toEqual(['WooCommerce', 'Shopify', 'Moneybird', 'Picqer']);
  });

  it('adds MCP servers where WeldAgent is served', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect', 'agent'], unavailableFeatures: ['integration-sync'] });
    render(<IntegrationsSection />);
    expect(shown()).toEqual(['MCP Servers', 'WooCommerce', 'Shopify', 'Moneybird', 'Picqer']);
  });

  it('labels a connector outside the EU on the EU edition, and says when it is switched off', () => {
    setRuntimeConfig({ backend: 'rust', edition: 'eu', modules: ['core', 'connect'], unavailableFeatures: ['integration-sync'] });
    outsideEu.data = {
      enforced: true,
      canManage: true,
      settingsPath: '/settings/outside-eu',
      integrations: { shopify: 'shopify' },
      services: [
        {
          id: 'shopify',
          name: 'Shopify',
          company: 'Shopify Inc.',
          country: 'CA',
          data: 'Products, stock levels, orders and customers',
          account: 'workspace',
          uses: [{ module: 'connect', key: 'connect-shopify', label: 'The Shopify connector' }],
          enabled: false,
        },
      ],
    };
    render(<IntegrationsSection />);
    expect(screen.getByTestId('outside-eu-badge-shopify')).toHaveTextContent('Leaves the EU');
    // Moneybird, Picqer and WooCommerce are not outside the EU.
    expect(screen.getAllByText('Leaves the EU')).toHaveLength(1);
    expect(screen.getByText('Switched off: Shopify')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Services outside the EU' })).toHaveAttribute('href', '/settings/outside-eu');
  });
});
