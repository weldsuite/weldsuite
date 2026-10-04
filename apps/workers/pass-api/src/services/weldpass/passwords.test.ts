/**
 * Unit tests for the pure parts of the password manager: TOTP against the
 * RFC's own vectors, CSV import across the formats people actually export,
 * and the strength / host helpers the API, platform and extension share.
 */

import { describe, it, expect } from 'vitest';
import {
  generatePassword,
  hostOf,
  hostsMatch,
  passwordStrength,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import { buildHealthReport, OLD_PASSWORD_DAYS } from './password-health';
import { ImportError, parseCsv, parseImport } from './password-import';
import type { ItemSummary } from './password-items';
import { parseTotp, totpCode, TotpError } from './totp';

describe('totp', () => {
  // RFC 6238 appendix B. The SHA-1 seed is ASCII "12345678901234567890".
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const at = (seconds: number) => new Date(seconds * 1000);

  it('matches the RFC 6238 SHA-1 vectors', async () => {
    const config = parseTotp(`otpauth://totp/Test?secret=${RFC_SECRET}&digits=8`);
    expect((await totpCode(config, at(59))).code).toBe('94287082');
    expect((await totpCode(config, at(1111111109))).code).toBe('07081804');
    expect((await totpCode(config, at(20000000000))).code).toBe('65353130');
  });

  it('defaults a bare secret to six digits every thirty seconds', async () => {
    const result = await totpCode(parseTotp(RFC_SECRET), at(59));
    expect(result.code).toBe('287082');
    expect(result.period).toBe(30);
    expect(result.expiresAt.getTime()).toBe(60_000);
  });

  it('accepts the spaced, lower-case form authenticator apps display', () => {
    expect(parseTotp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').secret).toEqual(
      parseTotp(RFC_SECRET).secret,
    );
  });

  it('rejects what it cannot use', () => {
    expect(() => parseTotp('not-base32-1!')).toThrow(TotpError);
    expect(() => parseTotp('otpauth://hotp/Test?secret=GEZDGNBV')).toThrow(TotpError);
    expect(() => parseTotp('otpauth://totp/Test')).toThrow(TotpError);
    expect(() => parseTotp('otpauth://totp/Test?secret=GEZDGNBV&digits=12')).toThrow(TotpError);
  });
});

describe('csv import', () => {
  it('parses quotes, doubled quotes and line breaks inside a field', () => {
    const records = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nlast,row');
    expect(records.map((record) => record.cells)).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
      ['last', 'row'],
    ]);
    // The third record starts on line 5: a blank line and an embedded break precede it.
    expect(records[2].line).toBe(5);
  });

  it('reads a LastPass export, including its secure notes', () => {
    const parsed = parseImport(
      [
        'url,username,password,totp,extra,name,grouping,fav',
        'https://github.com,octo,gh-pass,JBSWY3DPEHPK3PXP,my note,GitHub,Work,0',
        'http://sn,,,,"wifi: hunter2",Office wifi,,0',
      ].join('\n'),
    );
    expect(parsed.format).toBe('lastpass');
    expect(parsed.documents).toEqual([
      {
        type: 'login',
        title: 'GitHub',
        url: 'https://github.com',
        fields: { username: 'octo', password: 'gh-pass', totp: 'JBSWY3DPEHPK3PXP', notes: 'my note' },
      },
      { type: 'note', title: 'Office wifi', fields: { content: 'wifi: hunter2' } },
    ]);
  });

  it('reads a NordPass export with a card, skipping what it cannot hold', () => {
    const parsed = parseImport(
      [
        'name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,pin,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type,custom_fields',
        'Site,https://site.test,,me,site-pass,,,,,,,,,,,,,,,,,password,',
        'Visa,,,,,,Carol C,4111111111114242,123,,08/29,,,,,,,,,,,credit_card,',
        'Me,,,,,,,,,,,,,Carol C,,,,,,,,identity,',
      ].join('\n'),
    );
    expect(parsed.format).toBe('nordpass');
    expect(parsed.documents.map((document) => document.type)).toEqual(['login', 'card']);
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped[0].line).toBe(4);
  });

  it('reads Bitwarden and 1Password exports', () => {
    const bitwarden = parseImport(
      [
        'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
        ',,login,Bit,,,0,https://bit.test,me,bit-pass,',
        ',,note,Secret note,the body,,0,,,,',
      ].join('\n'),
    );
    expect(bitwarden.format).toBe('bitwarden');
    expect(bitwarden.documents.map((document) => document.type)).toEqual(['login', 'note']);

    const onePassword = parseImport(
      'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nOne,https://one.test,me,one-pass,,false,false,,',
    );
    expect(onePassword.format).toBe('1password');
    expect(onePassword.documents[0]).toMatchObject({ type: 'login', title: 'One' });
  });

  it('keeps a login whose 2FA secret is unreadable, and says so', () => {
    const parsed = parseImport(
      'name,url,username,password,totp\nSite,https://site.test,me,pw,not base32!!',
    );
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0]).toMatchObject({ fields: { totp: '' } });
    expect(parsed.warnings).toHaveLength(1);
  });

  it('falls back to the site for a missing title, and preserves password whitespace', () => {
    const parsed = parseImport('url,username,password\nhttps://www.fallback.test/x,me," spaced "');
    expect(parsed.documents[0]).toMatchObject({
      title: 'fallback.test',
      fields: { password: ' spaced ' },
    });
  });

  it('refuses a file with nothing to import from', () => {
    expect(() => parseImport('')).toThrow(ImportError);
    expect(() => parseImport('first name,last name\nA,B')).toThrow(ImportError);
  });
});

describe('password health', () => {
  const NOW = new Date('2026-10-04T00:00:00Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

  function entry(title: string, password: string, changedDaysAgo = 1) {
    const item = {
      id: `wpi_${title}`,
      title,
      passwordChangedAt: daysAgo(changedDaysAgo),
    } as unknown as ItemSummary;
    return { item, password };
  }

  it('flags weak, reused and old passwords, and counts each login once as healthy', () => {
    const strong = 'x9$Kq2!vLm8@Zr4#Tn6&';
    const report = buildHealthReport(
      [
        entry('weak', 'summer24'),
        entry('reused-a', 'Vk7#pQ2$wN9!mB4@'),
        entry('reused-b', 'Vk7#pQ2$wN9!mB4@'),
        entry('old', strong, OLD_PASSWORD_DAYS + 1),
        entry('fine', 'A different 1 entirely, long & unique'),
        entry('empty', ''),
      ],
      NOW,
    );

    expect(report).toMatchObject({ checked: 5, healthy: 1, weak: 1, reused: 2, old: 1 });
    expect(Object.fromEntries(report.items.map((item) => [item.title, item.issues]))).toEqual({
      weak: ['weak'],
      'reused-a': ['reused'],
      'reused-b': ['reused'],
      old: ['old'],
    });
  });
});

describe('shared helpers', () => {
  it('scores strength by more than length', () => {
    expect(passwordStrength('')).toBe('weak');
    expect(passwordStrength('password')).toBe('weak');
    expect(passwordStrength('Welkom123')).toBe('weak');
    expect(passwordStrength('aaaaaaaaaaaaaaaaaaaaaaaa')).toBe('weak');
    expect(passwordStrength('abcdefghijklmnopqrstuvwx')).toBe('weak');
    expect(passwordStrength('tr0ub4dor&3')).toBe('fair');
    expect(passwordStrength('x9$Kq2!vLm8@Zr4#Tn6&')).toBe('strong');
  });

  it('generates passwords that honour their options', () => {
    const password = generatePassword({ length: 24 });
    expect(password).toHaveLength(24);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^a-zA-Z0-9]/);
    expect(passwordStrength(password)).toBe('strong');

    expect(generatePassword({ length: 16, symbols: false, digits: false })).toMatch(/^[a-zA-Z]{16}$/);
    expect(generatePassword({ length: 2 })).toHaveLength(8);
    expect(generatePassword()).not.toBe(generatePassword());
  });

  it('reduces a URL to its host', () => {
    expect(hostOf('https://www.Example.com/login?x=1')).toBe('example.com');
    expect(hostOf('example.com/path')).toBe('example.com');
    expect(hostOf('http://localhost:3000')).toBe('localhost');
    expect(hostOf('javascript:alert(1)')).toBeNull();
    expect(hostOf('just words')).toBeNull();
    expect(hostOf('')).toBeNull();
  });

  it('matches a host to itself and to its subdomains, never to a sibling', () => {
    expect(hostsMatch('example.com', 'example.com')).toBe(true);
    expect(hostsMatch('example.com', 'accounts.example.com')).toBe(true);
    expect(hostsMatch('accounts.example.com', 'example.com')).toBe(true);
    expect(hostsMatch('example.com', 'notexample.com')).toBe(false);
    expect(hostsMatch('a.example.com', 'b.example.com')).toBe(false);
    expect(hostsMatch('com', 'example.com')).toBe(false);
  });
});
