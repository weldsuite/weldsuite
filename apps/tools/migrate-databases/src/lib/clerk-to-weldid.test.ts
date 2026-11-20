/**
 * Clerk's export and Backend API users into WeldID's import lines, against a
 * fixture shaped like the dashboard's user export: Clerk's header names (not
 * its order), `|` between several addresses, the TAB Clerk puts before a
 * value a spreadsheet would read as a formula, quoted fields. The digest is
 * the well-known bcrypt example and the key RFC 4648's test-style base32; no
 * real account's.
 */

import { describe, expect, it } from 'vitest';
import {
  fetchClerkUsers,
  formatConvertReport,
  parseCsv,
  readClerkExport,
  toWeldIdAccounts,
  type ClerkApiUser,
} from './clerk-to-weldid';

const ADA = 'user_2NNEqL2nrIRdJ194ndJqAHwAda1';
const BOB = 'user_2NNEqL2nrIRdJ194ndJqAHwBob2';
const CAROL = 'user_2NNEqL2nrIRdJ194ndJqAHwCar3';
const DAVE = 'user_2NNEqL2nrIRdJ194ndJqAHwDav4';
const ERIN = 'user_2NNEqL2nrIRdJ194ndJqAHwEri5';
const FRANK = 'user_2NNEqL2nrIRdJ194ndJqAHwFra6';

const DIGEST = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const KEY = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** The export, in the column order of Clerk's sample plus `created_at` in the middle. */
const EXPORT = [
  'id,first_name,last_name,username,created_at,primary_email_address,primary_phone_number,verified_email_addresses,unverified_email_addresses,verified_phone_numbers,unverified_phone_numbers,totp_secret,password_digest,password_hasher',
  `${ADA},Ada,"Lovelace, Countess",,1700000000000,ada@example.com,,ada@example.com|ada@old.example,,,,${KEY.toLowerCase()},${DIGEST},bcrypt`,
  `${BOB},Bob,,,1700000000001,bob@example.com,,,bob@example.com,,,,${DIGEST},bcrypt`,
  `${CAROL},Carol,,carol,1700000000002,,\t+31600000000,,,\t+31600000000,,,,`,
  `${DAVE},"Dave ""D""",Smith,,1700000000003,dave@example.com,,dave@example.com,,,,3132333435363738393031323334353637383930,$argon2id$v=19$m=65536$abc$def,argon2id`,
  `${ERIN},Erin,,,1700000000004,erin@example.com,,"erin@example.com|erin@work.example",,,,${KEY},${DIGEST},Bcrypt`,
].join('\r\n');

const verified = { status: 'verified' };

const API_USERS: ClerkApiUser[] = [
  {
    id: ADA,
    first_name: 'Ada',
    last_name: 'Lovelace, Countess',
    primary_email_address_id: 'idn_ada',
    email_addresses: [
      { id: 'idn_old', email_address: 'ada@old.example', verification: verified },
      { id: 'idn_ada', email_address: 'ada@example.com', verification: verified },
    ],
    external_accounts: [
      { provider: 'oauth_google', provider_user_id: '104857600000000000001', email_address: 'ada@gmail.com', verification: verified },
      { provider: 'oauth_microsoft', provider_user_id: 'AAAAAAAAAAAAAAAAAAAAAMsft', email_address: 'ada@contoso.com', verification: verified },
      { provider: 'oauth_apple', provider_user_id: '001234.ada.0042', email_address: 'ada@privaterelay.appleid.com', verification: verified },
      { provider: 'oauth_github', provider_user_id: '42', verification: verified },
      { provider: 'oauth_google', provider_user_id: '104857600000000000009', verification: { status: 'unverified' } },
    ],
    password_enabled: true,
    totp_enabled: true,
    backup_code_enabled: true,
    has_image: true,
    image_url: 'https://img.clerk.com/ada.png',
    passkeys: [{ id: 'pk_1' }],
  },
  {
    id: BOB,
    first_name: 'Bob',
    primary_email_address_id: 'idn_bob',
    email_addresses: [{ id: 'idn_bob', email_address: 'bob@example.com', verification: { status: 'unverified' } }],
    external_accounts: [{ provider: 'google', provider_user_id: '104857600000000000002', verification: verified }],
    password_enabled: true,
    has_image: false,
    image_url: 'https://img.clerk.com/default.png',
  },
  { id: CAROL, first_name: 'Carol', primary_email_address_id: null, email_addresses: [] },
  {
    id: DAVE,
    first_name: 'Dave "D"',
    last_name: 'Smith',
    primary_email_address_id: 'idn_dave',
    email_addresses: [{ id: 'idn_dave', email_address: 'dave@example.com', verification: verified }],
    password_enabled: true,
    totp_enabled: true,
    banned: true,
    saml_accounts: [{ id: 'samlacc_1' }],
  },
  {
    id: FRANK,
    first_name: 'Frank',
    primary_email_address_id: 'idn_frank',
    email_addresses: [{ id: 'idn_frank', email_address: 'frank@example.com', verification: verified }],
    // An older Google account: its subject in `google_id`, no provider.
    external_accounts: [{ google_id: '104857600000000000006', email_address: 'frank@gmail.com' }],
    password_enabled: true,
    totp_enabled: true,
  },
];

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, commas, CRLF and a missing final newline', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,,3\n')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '', '3'],
    ]);
    expect(parseCsv('﻿x,y\n"multi\nline",z')).toEqual([
      ['x', 'y'],
      ['multi\nline', 'z'],
    ]);
    expect(() => parseCsv('a,"open')).toThrow(/never ends/);
  });
});

describe('readClerkExport', () => {
  it('finds columns by header name and splits several addresses', () => {
    const rows = readClerkExport(EXPORT);
    expect([...rows.keys()]).toEqual([ADA, BOB, CAROL, DAVE, ERIN]);
    const ada = rows.get(ADA)!;
    expect(ada.lastName).toBe('Lovelace, Countess');
    expect(ada.verifiedEmails).toEqual(['ada@example.com', 'ada@old.example']);
    expect(ada.passwordDigest).toBe(DIGEST);
    expect(rows.get(DAVE)!.firstName).toBe('Dave "D"');
    expect(rows.get(ERIN)!.verifiedEmails).toEqual(['erin@example.com', 'erin@work.example']);
    expect(rows.get(ERIN)!.passwordHasher).toBe('bcrypt');
  });

  it('refuses a file that is not a user export', () => {
    expect(() => readClerkExport('')).toThrow(/empty/);
    expect(() => readClerkExport('name,email\nAda,ada@example.com')).toThrow(/no id column/);
  });
});

describe('toWeldIdAccounts', () => {
  it('turns the fixture into the lines WeldID imports, and counts what it leaves out', () => {
    const { accounts, report } = toWeldIdAccounts(readClerkExport(EXPORT), API_USERS);

    expect(accounts).toEqual([
      {
        id: ADA,
        email: 'ada@example.com',
        givenName: 'Ada',
        familyName: 'Lovelace, Countess',
        picture: 'https://img.clerk.com/ada.png',
        emailVerified: true,
        passwordHash: DIGEST,
        totpSecret: KEY,
        // Google by its subject; Microsoft, Apple (not asked) and GitHub left out.
        links: [{ provider: 'google', subject: '104857600000000000001', email: 'ada@gmail.com' }],
      },
      // Never proven: imported bare, so nothing goes to whoever proves it.
      { id: BOB, email: 'bob@example.com', givenName: 'Bob', emailVerified: false },
      // Carol has no address: left out.
      {
        id: DAVE,
        email: 'dave@example.com',
        givenName: 'Dave "D"',
        familyName: 'Smith',
        emailVerified: true,
        disabled: true,
      },
      {
        id: FRANK,
        email: 'frank@example.com',
        givenName: 'Frank',
        emailVerified: true,
        links: [{ provider: 'google', subject: '104857600000000000006', email: 'frank@gmail.com' }],
      },
      // Only in the export: proven by its verified addresses there.
      { id: ERIN, email: 'erin@example.com', givenName: 'Erin', emailVerified: true, passwordHash: DIGEST, totpSecret: KEY },
    ]);

    expect(report).toEqual({
      users: 6,
      accounts: 5,
      emailVerified: 4,
      passwords: 2,
      totp: 2,
      links: { google: 2 },
      disabled: 1,
      noEmail: [CAROL],
      onlyInExport: 1,
      onlyInApi: 1,
      unverifiedBare: 1,
      passwordNotBcrypt: 1,
      passwordNotExported: 1,
      totpNotBase32: 1,
      totpNotExported: 1,
      linksLeftOut: { microsoft: 1, apple: 1, github: 1 },
      passkeys: 1,
      backupCodes: 1,
      enterpriseAccounts: 1,
      clerkHostedPictures: 1,
    });
  });

  it('links Apple accounts only when asked', () => {
    const { accounts, report } = toWeldIdAccounts(readClerkExport(EXPORT), API_USERS, { appleLinks: true });
    expect(accounts[0].links).toEqual([
      { provider: 'google', subject: '104857600000000000001', email: 'ada@gmail.com' },
      { provider: 'apple', subject: '001234.ada.0042', email: 'ada@privaterelay.appleid.com' },
    ]);
    expect(report.links).toEqual({ google: 2, apple: 1 });
    expect(report.linksLeftOut).toEqual({ microsoft: 1, github: 1 });
  });

  it('writes, byte for byte, the lines WeldID imports in its contract test', () => {
    // weldsuite/weldid: crates/weldid-server/tests/server/cli_import.rs,
    // CLERK_CONVERTER_LINES (`the_clerk_converters_lines_import`). Keep the two in step.
    const { accounts } = toWeldIdAccounts(readClerkExport(EXPORT), API_USERS, { appleLinks: true });
    expect(accounts.map((a) => JSON.stringify(a))).toEqual([
      '{"id":"user_2NNEqL2nrIRdJ194ndJqAHwAda1","email":"ada@example.com","givenName":"Ada","familyName":"Lovelace, Countess","picture":"https://img.clerk.com/ada.png","emailVerified":true,"passwordHash":"$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy","totpSecret":"JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP","links":[{"provider":"google","subject":"104857600000000000001","email":"ada@gmail.com"},{"provider":"apple","subject":"001234.ada.0042","email":"ada@privaterelay.appleid.com"}]}',
      '{"id":"user_2NNEqL2nrIRdJ194ndJqAHwBob2","email":"bob@example.com","givenName":"Bob","emailVerified":false}',
      '{"id":"user_2NNEqL2nrIRdJ194ndJqAHwDav4","email":"dave@example.com","givenName":"Dave \\"D\\"","familyName":"Smith","emailVerified":true,"disabled":true}',
      '{"id":"user_2NNEqL2nrIRdJ194ndJqAHwFra6","email":"frank@example.com","givenName":"Frank","emailVerified":true,"links":[{"provider":"google","subject":"104857600000000000006","email":"frank@gmail.com"}]}',
      '{"id":"user_2NNEqL2nrIRdJ194ndJqAHwEri5","email":"erin@example.com","givenName":"Erin","emailVerified":true,"passwordHash":"$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy","totpSecret":"JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"}',
    ]);
  });

  it('keeps addresses, digests and keys out of the report', () => {
    const { report } = toWeldIdAccounts(readClerkExport(EXPORT), API_USERS);
    const text = formatConvertReport(report).join('\n');
    for (const secret of [DIGEST, KEY, 'ada@example.com', 'ada@gmail.com', '104857600000000000001']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(CAROL);
  });
});

describe('fetchClerkUsers', () => {
  it('reads every page with the secret key', async () => {
    const all = Array.from({ length: 501 }, (_, i) => ({ id: `user_${String(i).padStart(24, '0')}` }));
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      seen.push(`${u.pathname}?${u.searchParams}`);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_x');
      const offset = Number(u.searchParams.get('offset'));
      const limit = Number(u.searchParams.get('limit'));
      return new Response(JSON.stringify(all.slice(offset, offset + limit)));
    }) as typeof fetch;
    const users = await fetchClerkUsers('sk_test_x', fetchFn);
    expect(users).toHaveLength(501);
    expect(seen).toEqual([
      '/v1/users?limit=500&offset=0&order_by=created_at',
      '/v1/users?limit=500&offset=500&order_by=created_at',
    ]);
  });

  it('fails on an HTTP error, naming the status only', async () => {
    const fetchFn = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(fetchClerkUsers('sk_test_x', fetchFn)).rejects.toThrow('Clerk /users: HTTP 401');
  });
});
