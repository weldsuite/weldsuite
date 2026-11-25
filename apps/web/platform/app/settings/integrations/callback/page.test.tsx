import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: en, language: 'en', format: interpolate }) };
});

const calls = vi.hoisted(() => ({ workflow: [] as unknown[], connector: [] as unknown[] }));
vi.mock('@/hooks/queries/use-workflow-integration-queries', () => ({
  useWorkflowProviderCallback: () => ({ mutate: (input: unknown) => calls.workflow.push(input) }),
}));
vi.mock('@/hooks/queries/use-connector-queries', () => ({
  useConnectorOAuthCallback: () => ({ mutate: (input: unknown) => calls.connector.push(input) }),
  useSelectConnectorAccount: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { en } from '@weldsuite/i18n/locales/en';
import { markOAuthFlow } from '@/lib/integrations-oauth-flow';
import IntegrationsCallbackPage from './page';
import { safeReturnPath } from './connector-callback';

afterEach(() => {
  sessionStorage.clear();
  calls.workflow = [];
  calls.connector = [];
});

describe('Settings → Integrations OAuth callback', () => {
  it('finishes a workflow connection for the provider the flow recorded', () => {
    markOAuthFlow({ kind: 'workflow', provider: 'slack', returnTo: '/settings/integrations/slack' });
    render(<IntegrationsCallbackPage code="c1" state="s1" error={undefined} />);
    expect(calls.workflow).toEqual([{ provider: 'slack', code: 'c1', state: 's1' }]);
    expect(calls.connector).toEqual([]);
  });

  it('finishes a connector when the flow was a connector', () => {
    markOAuthFlow({ kind: 'connector' });
    render(<IntegrationsCallbackPage code="c1" state="stripe_s1" error={undefined} />);
    expect(calls.connector).toEqual([{ provider: 'stripe', code: 'c1', state: 'stripe_s1' }]);
    expect(calls.workflow).toEqual([]);
  });

  it('treats an unrecorded flow as Moneybird or Stripe, whose state says which', () => {
    render(<IntegrationsCallbackPage code="c1" state="mb_s1" error={undefined} />);
    expect(calls.connector).toEqual([{ provider: 'moneybird', code: 'c1', state: 'mb_s1' }]);
  });

  it('the old WeldConnect workflow URL finishes a workflow flow, and says so when the provider is unknown', () => {
    markOAuthFlow({ kind: 'connector' });
    render(<IntegrationsCallbackPage code="c1" state="s1" error={undefined} flow="workflow" />);
    expect(calls.workflow).toEqual([]);
    expect(screen.getByText(en.settings.integrations.workflowConnections.callback.errorMissingProvider)).toBeInTheDocument();
  });

  it('returns a connector to its Settings page only', () => {
    expect(safeReturnPath(`${window.location.origin}/w/acme/settings/integrations/moneybird`)).toBe('/w/acme/settings/integrations/moneybird');
    // The old connectors page is gone: back to the integrations list.
    expect(safeReturnPath(`${window.location.origin}/w/acme/weldconnect/connectors`)).toBe('/settings/integrations');
    expect(safeReturnPath('https://evil.example/settings/integrations')).toBe('/settings/integrations');
    expect(safeReturnPath(undefined)).toBe('/settings/integrations');
  });
});
