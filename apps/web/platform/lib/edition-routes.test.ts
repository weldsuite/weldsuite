import { afterEach, describe, expect, it } from 'vitest';
import { isHrefOffered, isRouteOffered, routeRequirement } from './edition-routes';
import { setRuntimeConfig } from './runtime-config';

const EU_CONFIG = {
  backend: 'rust',
  edition: 'eu',
  modules: ['core', 'know', 'sign', 'pass', 'calendar'],
  unavailableFeatures: ['sso-connections', 'billing', 'credit-top-up', 'paid-apps', 'desktop-sign-in', 'analytics', 'search-reindex', 'helpcenter-custom-domains'],
};

afterEach(() => setRuntimeConfig(null));

describe('route availability', () => {
  it('offers every page on Global', () => {
    for (const path of ['/weldcrm/companies', '/agents', '/settings/billing', '/settings/sso', '/social/posts']) {
      expect(isRouteOffered(path)).toBe(true);
    }
  });

  it('maps a page to the module of its app', () => {
    expect(routeRequirement('/weldcrm/companies')).toEqual({ modules: ['crm'] });
    expect(routeRequirement('/weldflow')).toEqual({ modules: ['flow'] });
    expect(routeRequirement('/social/posts')).toEqual({ modules: ['social'] });
    expect(routeRequirement('/settings/apps/weldmail/signatures')).toEqual({ modules: ['mail'] });
    expect(routeRequirement('/agents/abc')).toEqual({ modules: ['agent'] });
    expect(routeRequirement('/settings/billing')).toEqual({ anyFeature: ['billing', 'credit-top-up'] });
  });

  it('offers the billing page for the credit top-up alone', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core'], unavailableFeatures: ['billing'] });
    expect(isRouteOffered('/settings/billing')).toBe(true);
    expect(isRouteOffered('/settings/plans')).toBe(false);
    setRuntimeConfig({ backend: 'rust', modules: ['core'], unavailableFeatures: ['billing', 'credit-top-up'] });
    expect(isRouteOffered('/settings/billing')).toBe(false);
  });

  it('hides the WeldMail pages of a feature the backend lacks, and only those', () => {
    expect(routeRequirement('/weldmail/ai/summary')).toEqual({ modules: ['mail'], feature: 'mail-ai' });
    expect(routeRequirement('/weldmail/domains')).toEqual({ modules: ['mail'], feature: 'mail-domains' });
    setRuntimeConfig({ backend: 'rust', modules: ['mail'], unavailableFeatures: ['mail-ai', 'mail-domains'] });
    expect(isRouteOffered('/weldmail/ai/smart-reply')).toBe(false);
    expect(isRouteOffered('/weldmail/domains')).toBe(false);
    expect(isRouteOffered('/weldmail/setup')).toBe(true);
    expect(isRouteOffered('/settings/apps/weldmail')).toBe(true);
  });

  it('hides buying and porting phone numbers without the feature, and only those', () => {
    expect(routeRequirement('/settings/apps/phone-numbers/new-number')).toEqual({ modules: ['call'], feature: 'phone-number-purchase' });
    expect(routeRequirement('/settings/apps/phone-numbers/port/vpo_1')).toEqual({ modules: ['call'], feature: 'phone-number-purchase' });
    setRuntimeConfig({ backend: 'rust', modules: ['call'], unavailableFeatures: ['phone-number-purchase'] });
    expect(isRouteOffered('/settings/apps/phone-numbers/new-number')).toBe(false);
    expect(isRouteOffered('/settings/apps/phone-numbers/port')).toBe(false);
    expect(isRouteOffered('/settings/apps/phone-numbers')).toBe(true);
  });

  it('hides the WeldPanel settings without the backend behind them', () => {
    expect(routeRequirement('/settings/apps/weldpanel?tab=exports')).toEqual({ modules: ['panel'], feature: 'panel-analytics' });
    setRuntimeConfig({ backend: 'rust', modules: ['panel'], unavailableFeatures: ['panel-analytics'] });
    expect(isRouteOffered('/settings/apps/weldpanel')).toBe(false);
    expect(isRouteOffered('/weldpanel/projects')).toBe(true);
  });

  it('hides WeldStash settings and Replenishment where stash-replenishment is missing, such as Global', () => {
    expect(routeRequirement('/settings/apps/weldstash')).toEqual({ modules: ['stash'], feature: 'stash-replenishment' });
    expect(routeRequirement('/weldstash/replenishment')).toEqual({ modules: ['stash'], feature: 'stash-replenishment' });
    // Global has no runtime config: GLOBAL_UNAVAILABLE_FEATURES lists the feature.
    expect(isRouteOffered('/settings/apps/weldstash')).toBe(false);
    expect(isRouteOffered('/weldstash/replenishment')).toBe(false);
    expect(isRouteOffered('/weldstash/purchase-orders')).toBe(true);
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'stash'], unavailableFeatures: [] });
    expect(isRouteOffered('/settings/apps/weldstash')).toBe(true);
    expect(isRouteOffered('/weldstash/replenishment?plan=x')).toBe(true);
  });

  it('offers the services-outside-the-EU settings on the EU edition only (ADR OPS-026)', () => {
    expect(routeRequirement('/settings/outside-eu')).toEqual({ feature: 'outside-eu-services' });
    // Global: in GLOBAL_UNAVAILABLE_FEATURES.
    expect(isRouteOffered('/settings/outside-eu')).toBe(false);
    // Self-hosted lists it as unavailable; the EU edition doesn't.
    setRuntimeConfig({ backend: 'rust', edition: 'self-hosted', unavailableFeatures: ['outside-eu-services'] });
    expect(isRouteOffered('/settings/outside-eu')).toBe(false);
    setRuntimeConfig({ backend: 'rust', edition: 'eu', unavailableFeatures: [] });
    expect(isRouteOffered('/settings/outside-eu')).toBe(true);
  });

  it('needs only core for platform pages', () => {
    for (const path of ['/', '/settings', '/settings/team', '/appstore', '/apps/my-app', '/objects/machines', '/documents/f_1', '/settings/apps/weldsuite']) {
      expect(routeRequirement(path), path).toBeNull();
    }
  });

  it('ignores a query string and hash', () => {
    expect(routeRequirement('/weldcrm?new=1')).toEqual({ modules: ['crm'] });
    expect(routeRequirement('/settings/billing#invoices')).toEqual({ anyFeature: ['billing', 'credit-top-up'] });
  });

  it('offers /settings/ai only where the install runs AI', () => {
    expect(isRouteOffered('/settings/ai')).toBe(false);
    setRuntimeConfig({
      ...EU_CONFIG,
      ai: { defaultProvider: 'mistral', providers: [{ id: 'mistral', region: 'eu', keySources: ['weldsuite'] }] },
    });
    expect(isRouteOffered('/settings/ai')).toBe(true);
  });

  it('matches whole segments only', () => {
    expect(routeRequirement('/settings/ssox')).toBeNull();
    expect(routeRequirement('/agentsx')).toBeNull();
  });

  it('on the EU edition, offers the ported modules and core, nothing else', () => {
    setRuntimeConfig(EU_CONFIG);
    for (const path of ['/', '/weldknow', '/weldsign/documents', '/weldpass', '/weldcalendar/week', '/welddrive', '/settings/team', '/settings/apps/weldcalendar', '/appstore']) {
      expect(isRouteOffered(path), path).toBe(true);
    }
    for (const path of [
      '/weldcrm/companies',
      '/weldmail',
      '/weldchat',
      '/agents',
      '/new-chat',
      '/call-room',
      '/social',
      '/settings/sso',
      '/settings/plans',
      '/settings/billing/invoices',
      '/settings/integrations',
      '/settings/webhooks',
      '/settings/entities',
      '/settings/apps/phone-numbers',
      '/settings/apps/weldmail',
    ]) {
      expect(isRouteOffered(path), path).toBe(false);
    }
  });

  it('checks in-app links, with their query, hash and workspace prefix', () => {
    setRuntimeConfig(EU_CONFIG);
    expect(isHrefOffered('/weldknow/articles?space=1#top')).toBe(true);
    expect(isHrefOffered('/w/acme/weldcrm/companies?stack=company:1')).toBe(false);
    expect(isHrefOffered('/agents?conversation=c_1')).toBe(false);
    expect(isHrefOffered('https://example.com/weldcrm')).toBe(true);
  });

  it('offers a page shared by two modules when either is served', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'hr'] });
    expect(isRouteOffered('/settings/entities')).toBe(true);
  });

  it('hides the integrations whose syncs the backend lacks, and MCP servers without WeldAgent', () => {
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'connect'], unavailableFeatures: ['integration-sync'] });
    expect(isRouteOffered('/settings/integrations')).toBe(true);
    for (const path of ['/settings/integrations/attio', '/settings/integrations/sendcloud', '/settings/integrations/int_1']) {
      expect(isRouteOffered(path), path).toBe(false);
    }
    expect(isRouteOffered('/settings/integrations/mcp-servers')).toBe(false);
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'connect', 'agent'], unavailableFeatures: ['integration-sync'] });
    expect(isRouteOffered('/settings/integrations/mcp-servers')).toBe(true);
    setRuntimeConfig(null);
    expect(isRouteOffered('/settings/integrations/attio')).toBe(true);
  });

  it('offers API keys on a Kubernetes edition only once it names the public API', () => {
    expect(isRouteOffered('/settings/api-keys')).toBe(true);
    setRuntimeConfig({ backend: 'rust', modules: ['core'] });
    expect(isRouteOffered('/settings/api-keys')).toBe(false);
    setRuntimeConfig({ backend: 'rust', modules: ['core'], env: { VITE_EXTERNAL_API_URL: 'https://api.example.eu' } });
    expect(isRouteOffered('/settings/api-keys')).toBe(true);
  });

  it("offers WeldDesk's BI connector only where the public API it feeds from is named", () => {
    expect(isRouteOffered('/welddesk/reports/bi-connector')).toBe(true);
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'desk'] });
    expect(isRouteOffered('/welddesk/reports/bi-connector')).toBe(false);
    expect(isRouteOffered('/welddesk/reports')).toBe(true);
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'desk'], env: { VITE_EXTERNAL_API_URL: 'https://api.example.eu' } });
    expect(isRouteOffered('/welddesk/reports/bi-connector')).toBe(true);
  });

  it('hides the help center settings where the edition hosts no help center, and only those', () => {
    expect(isRouteOffered('/settings/apps/welddesk/help-center')).toBe(true);
    setRuntimeConfig({ backend: 'rust', modules: ['core', 'desk'], unavailableFeatures: ['helpcenter-hosting'] });
    expect(isRouteOffered('/settings/apps/welddesk/help-center')).toBe(false);
    expect(isRouteOffered('/settings/apps/welddesk/chat-widget')).toBe(true);
    expect(isRouteOffered('/welddesk/help-center/articles')).toBe(true);
  });
});
