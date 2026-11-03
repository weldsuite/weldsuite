import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import type { UserApp } from '@/hooks/queries/use-user-apps-queries';
import { buildManifestTemplate, bumpPatch, latestVersion, manifestErrorDetails } from './upload-version-helpers';

function makeApp(overrides: Partial<UserApp> = {}): UserApp {
  return {
    id: 'uap_1',
    code: 'e2e-test-app',
    name: 'E2E Test App',
    requestedScopes: [],
    manifest: null,
    ...overrides,
  } as UserApp;
}

function templateVersion(app: UserApp, versions: string[]): string {
  return (JSON.parse(buildManifestTemplate(app, versions)) as { version: string }).version;
}

describe('upload version helpers', () => {
  it('bumps the patch number', () => {
    expect(bumpPatch('1.2.3')).toBe('1.2.4');
    expect(bumpPatch('abc')).toBe('0.0.1');
  });

  it('picks the highest version numerically', () => {
    expect(latestVersion(['0.0.9', '0.0.10', '0.1.0', 'abc'])).toBe('0.1.0');
    expect(latestVersion(['0.0.9', '0.0.10'])).toBe('0.0.10');
    expect(latestVersion([])).toBeNull();
  });

  it('starts a new app at 0.0.1', () => {
    expect(templateVersion(makeApp(), [])).toBe('0.0.1');
  });

  it('suggests the version after the newest upload, not the stale manifest', () => {
    // The app row still carries 0.0.1 while 0.0.2 was just uploaded.
    const app = makeApp({ manifest: { version: '0.0.1', scopes: ['contacts:read'] } });
    expect(templateVersion(app, ['0.0.1', '0.0.2'])).toBe('0.0.3');
    // A version awaiting review isn't in the manifest yet either.
    expect(templateVersion(makeApp({ manifest: { version: '1.0.0' } }), ['1.0.0', '1.0.1'])).toBe('1.0.2');
  });

  it('keeps the current scopes in the template', () => {
    const app = makeApp({ manifest: { version: '0.0.1', scopes: ['contacts:read'] } });
    expect(JSON.parse(buildManifestTemplate(app, ['0.0.1'])).scopes).toEqual(['contacts:read']);
  });

  it('turns a rejected manifest into one readable line', () => {
    const err = new ApiError('Invalid manifest', 400, {
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid manifest',
        details: { formErrors: [], fieldErrors: { version: ['semver (e.g. 1.0.0)'] } },
      },
    });
    expect(manifestErrorDetails(err)).toBe('version: semver (e.g. 1.0.0)');
  });

  it('returns null for errors without field details', () => {
    expect(manifestErrorDetails(new ApiError('Version 0.0.1 already exists', 409, { error: { message: 'x' } }))).toBeNull();
    expect(manifestErrorDetails(new Error('boom'))).toBeNull();
  });
});
