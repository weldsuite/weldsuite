import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig, RUNTIME_CONFIG_PATH } from './runtime-config';

const OIDC = {
  provider: 'oidc',
  issuer: 'https://auth.example.eu',
  clientId: 'web',
  mobileClientId: 'mobile',
  audience: 'project',
  orgClaim: 'urn:zitadel:iam:org:project:project:roles',
};

describe('runtime config (/config.json)', () => {
  it('lives at /config.json', () => {
    expect(RUNTIME_CONFIG_PATH).toBe('/config.json');
  });

  it('reads a Kubernetes document with the web and mobile OIDC clients', () => {
    const config = parseRuntimeConfig({
      backend: 'rust',
      version: '0.3.0',
      edition: 'eu',
      modules: ['core', 'mail'],
      unavailableFeatures: ['billing'],
      apiBaseUrl: 'https://app.example.eu',
      realtimeUrl: 'wss://app.example.eu/ws',
      videoProvider: 'livekit',
      auth: { ...OIDC, signIn: 'platform' },
      env: { VITE_MAPBOX_ACCESS_TOKEN: 'pk.x' },
    });
    expect(config?.auth).toMatchObject({ provider: 'oidc', clientId: 'web', mobileClientId: 'mobile', signIn: 'platform' });
    expect(config?.modules).toEqual(['core', 'mail']);
  });

  it('reads a Clerk document and an empty one', () => {
    expect(parseRuntimeConfig({ auth: { provider: 'clerk', publishableKey: 'pk_test_x' } })?.auth).toEqual({
      provider: 'clerk',
      publishableKey: 'pk_test_x',
    });
    expect(parseRuntimeConfig({})).toEqual({});
  });

  it('treats an unknown signIn value as the provider pages and ignores unknown fields', () => {
    const config = parseRuntimeConfig({ auth: { ...OIDC, signIn: 'magic' }, futureField: true });
    expect(config?.auth).toMatchObject({ provider: 'oidc' });
    expect(config?.auth && 'signIn' in config.auth ? config.auth.signIn : undefined).toBeUndefined();
    expect(config).not.toHaveProperty('futureField');
  });

  it('refuses a document that breaks the contract', () => {
    expect(parseRuntimeConfig(null)).toBeNull();
    expect(parseRuntimeConfig('<html>')).toBeNull();
    expect(parseRuntimeConfig({ auth: { provider: 'saml' } })).toBeNull();
    expect(parseRuntimeConfig({ auth: { provider: 'oidc', issuer: 'not a url' } })).toBeNull();
    expect(parseRuntimeConfig({ modules: 'core' })).toBeNull();
  });
});
