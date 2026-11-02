import { describe, expect, it } from 'vitest';
import { activeOrganizationId, organizationsFromClaims, personFromClaims, scopeFor } from './claims';

const PROJECT_ROLES = 'urn:zitadel:iam:org:project:3001:roles';

/** A token requested without an organization scope: every workspace. */
const unscoped = {
  sub: '2891',
  name: 'Anna de Vries',
  given_name: 'Anna',
  family_name: 'de Vries',
  preferred_username: 'anna',
  email: 'anna@acme.test',
  picture: 'https://id.example.eu/avatar.png',
  'urn:zitadel:iam:org:id': 'org_acme',
  'urn:zitadel:iam:user:resourceowner:id': 'org_acme',
  'urn:zitadel:iam:user:resourceowner:name': 'Acme BV',
  'urn:zitadel:iam:org:project:roles': {
    admin: { org_acme: 'acme.id.example.eu' },
    member: { org_acme: 'acme.id.example.eu', org_globex: 'globex.id.example.eu' },
  },
  [PROJECT_ROLES]: {
    admin: { org_acme: 'acme.id.example.eu' },
    member: { org_acme: 'acme.id.example.eu', org_globex: 'globex.id.example.eu' },
  },
};

/** The same person's token requested with `urn:zitadel:iam:org:roles:id:org_globex`. */
const narrowed = {
  ...unscoped,
  'urn:zitadel:iam:org:project:roles': { member: { org_globex: 'globex.id.example.eu' } },
  [PROJECT_ROLES]: { member: { org_globex: 'globex.id.example.eu' } },
};

describe('activeOrganizationId (the backend reading of the org claim)', () => {
  it('is none while the roles claim spans several organizations', () => {
    expect(activeOrganizationId(unscoped, PROJECT_ROLES)).toBeNull();
  });

  it('is the one organization a narrowed token grants roles in', () => {
    expect(activeOrganizationId(narrowed, PROJECT_ROLES)).toBe('org_globex');
  });

  it("reads a string claim as the id, which is why Zitadel's org id claim fails several workspaces", () => {
    // urn:zitadel:iam:org:id names the person's own organization whatever they asked for.
    expect(activeOrganizationId(narrowed, 'urn:zitadel:iam:org:id')).toBe('org_acme');
  });

  it('takes an array with one distinct id and nothing else', () => {
    expect(activeOrganizationId({ g: ['ws_1', 'ws_1'] }, 'g')).toBe('ws_1');
    expect(activeOrganizationId({ g: ['ws_1', 'ws_2'] }, 'g')).toBeNull();
    expect(activeOrganizationId({ g: 291 }, 'g')).toBeNull();
    expect(activeOrganizationId({}, 'g')).toBeNull();
  });
});

describe('organizationsFromClaims', () => {
  it('lists every workspace from an unscoped token, the own organization by name', () => {
    expect(organizationsFromClaims(unscoped, PROJECT_ROLES)).toEqual([
      { id: 'org_acme', name: 'Acme BV', slug: null },
      { id: 'org_globex', name: 'globex.id.example.eu', slug: null },
    ]);
  });

  it('lists only the active workspace from a narrowed token', () => {
    expect(organizationsFromClaims(narrowed, PROJECT_ROLES).map((o) => o.id)).toEqual(['org_globex']);
  });

  it('reads a group claim for other providers', () => {
    expect(organizationsFromClaims({ groups: ['ws_1', 'ws_2', 'ws_1'] }, 'groups').map((o) => o.id)).toEqual([
      'ws_1',
      'ws_2',
    ]);
  });
});

describe('scopeFor', () => {
  it('fills the Zitadel scope templates', () => {
    expect(scopeFor('urn:zitadel:iam:org:roles:id:{orgId}', { orgId: '291' })).toBe('urn:zitadel:iam:org:roles:id:291');
    expect(scopeFor('urn:zitadel:iam:org:project:id:{audience}:aud', { audience: '3001' })).toBe(
      'urn:zitadel:iam:org:project:id:3001:aud',
    );
  });
});

describe('personFromClaims', () => {
  it('maps the standard profile claims', () => {
    expect(personFromClaims(unscoped)).toEqual({
      id: '2891',
      firstName: 'Anna',
      lastName: 'de Vries',
      fullName: 'Anna de Vries',
      username: 'anna',
      imageUrl: 'https://id.example.eu/avatar.png',
      email: 'anna@acme.test',
    });
  });

  it('joins the name parts when there is no name claim, and needs a subject', () => {
    expect(personFromClaims({ sub: '1', given_name: 'Ada' })?.fullName).toBe('Ada');
    expect(personFromClaims({ sub: '1' })?.fullName).toBeNull();
    expect(personFromClaims({ name: 'No subject' })).toBeNull();
  });
});
