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
    expect(routeRequirement('/settings/billing')).toEqual({ feature: 'billing' });
  });

  it('hides the WeldMail pages of a feature the backend lacks, and only those', () => {
    expect(routeRequirement('/weldmail/ai/summary')).toEqual({ modules: ['mail'], feature: 'mail-ai' });
    expect(routeRequirement('/weldmail/domains')).toEqual({ modules: ['mail'], feature: 'mail-domains' });
    setRuntimeConfig({ backend: 'rust', modules: ['mail'], unavailableFeatures: ['mail-ai', 'mail-domains'] });
    expect(isRouteOffered('/weldmail/ai/smart-reply')).toBe(false);
    expect(isRouteOffered('/weldmail/domains')).toBe(false);
    expect(isRouteOffered('/weldmail/setup')).toBe(true);
    expect(isRouteOffered('/weldmail/settings/labels')).toBe(true);
  });

  it('needs only core for platform pages', () => {
    for (const path of ['/', '/settings', '/settings/team', '/appstore', '/apps/my-app', '/objects/machines', '/documents/f_1', '/settings/apps/weldsuite']) {
      expect(routeRequirement(path), path).toBeNull();
    }
  });

  it('ignores a query string and hash', () => {
    expect(routeRequirement('/weldcrm?new=1')).toEqual({ modules: ['crm'] });
    expect(routeRequirement('/settings/billing#invoices')).toEqual({ feature: 'billing' });
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
});
