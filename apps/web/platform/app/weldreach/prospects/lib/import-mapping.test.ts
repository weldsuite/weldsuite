import { describe, expect, it } from 'vitest';
import type { ReachImportReport } from '@weldsuite/app-api-client/schemas/reach';
import { parseCsv } from './csv';
import {
  chunk,
  customFieldKey,
  customFieldKeys,
  guessMapping,
  looksLikeEmail,
  mergeReports,
  prepareImport,
  unmappedColumns,
} from './import-mapping';

describe('guessMapping', () => {
  it('matches English headers regardless of case and punctuation', () => {
    const mapping = guessMapping(['E-mail', 'First Name', 'Last_Name', 'Company', 'Job Title', 'Phone']);
    expect(mapping).toEqual({
      email: 0,
      firstName: 1,
      lastName: 2,
      companyName: 3,
      title: 4,
      timezone: null,
    });
  });

  it('matches Dutch headers', () => {
    const mapping = guessMapping(['E-mailadres', 'Voornaam', 'Achternaam', 'Bedrijf', 'Functie']);
    expect(mapping.email).toBe(0);
    expect(mapping.firstName).toBe(1);
    expect(mapping.lastName).toBe(2);
    expect(mapping.companyName).toBe(3);
    expect(mapping.title).toBe(4);
  });

  it('uses a column for one field only', () => {
    const mapping = guessMapping(['email', 'email address']);
    expect(mapping.email).toBe(0);
    expect(unmappedColumns(['email', 'email address'], mapping)).toEqual([1]);
  });
});

describe('customFieldKey', () => {
  it('makes a header usable as a template variable', () => {
    expect(customFieldKey('Phone Number')).toBe('phone_number');
    expect(customFieldKey('  LinkedIn URL!  ')).toBe('linkedin_url');
    expect(customFieldKey('???')).toBe('field');
  });

  it('keeps keys unique', () => {
    const keys = customFieldKeys(['City', 'city', 'CITY'], [0, 1, 2]);
    expect([...keys.values()]).toEqual(['city', 'city_2', 'city_3']);
  });
});

describe('prepareImport', () => {
  const csv = [
    'Email,First Name,Company,Industry',
    'ana@acme.com,Ana,Acme,Software',
    'ANA@acme.com,Ana again,Acme,Software',
    'bo@gmail.com,Bo,,Retail',
    'info@widgets.nl,,Widgets,',
    'not-an-email,Cy,Cyco,Energy',
    ',Di,Dico,Energy',
  ].join('\n');

  it('maps rows, dedupes, and counts the hints', () => {
    const parsed = parseCsv(csv);
    const mapping = guessMapping(parsed.headers);
    const custom = unmappedColumns(parsed.headers, mapping);
    const keys = customFieldKeys(parsed.headers, custom);
    const { rows, stats } = prepareImport(parsed, mapping, custom, keys);

    expect(stats).toEqual({ total: 6, invalid: 2, duplicate: 1, consumer: 1, role: 1 });
    expect(rows.map((row) => row.email)).toEqual(['ana@acme.com', 'bo@gmail.com', 'info@widgets.nl']);
    expect(rows[0]).toMatchObject({
      firstName: 'Ana',
      companyName: 'Acme',
      customFields: { industry: 'Software' },
    });
    // Empty cells are left out, not sent as empty strings.
    expect(rows[1]?.companyName).toBeUndefined();
    expect(rows[2]?.customFields).toBeUndefined();
  });

  it('imports only the custom columns that were chosen', () => {
    const parsed = parseCsv('email,city,notes\nana@acme.com,Ghent,hello');
    const mapping = guessMapping(parsed.headers);
    const keys = customFieldKeys(parsed.headers, [1]);
    const { rows } = prepareImport(parsed, mapping, [1], keys);
    expect(rows[0]?.customFields).toEqual({ city: 'Ghent' });
  });
});

describe('looksLikeEmail', () => {
  it('accepts an address with a dotted domain', () => {
    expect(looksLikeEmail('ana@acme.com')).toBe(true);
    expect(looksLikeEmail('a.b+c@sub.acme.co.uk')).toBe(true);
  });

  it('rejects what cannot be an address', () => {
    for (const value of ['not-an-email', 'a@b', '@acme.com', 'a@@acme.com', 'a b@acme.com', 'a@.com', 'a@acme.', '']) {
      expect(looksLikeEmail(value), value).toBe(false);
    }
  });
});

describe('chunk', () => {
  it('splits into requests of at most `size` rows', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe('mergeReports', () => {
  it('sums the requests and adds what was never sent', () => {
    const reports: ReachImportReport[] = [
      { listId: 'list_1', created: 10, updated: 2, skipped: [{ reason: 'consumer', count: 3 }] },
      { listId: 'list_1', created: 5, updated: 0, skipped: [{ reason: 'consumer', count: 1 }, { reason: 'role', count: 2 }] },
    ];
    expect(mergeReports(reports, { invalid: 4, duplicate: 0 })).toEqual({
      listId: 'list_1',
      created: 15,
      updated: 2,
      skipped: [
        { reason: 'consumer', count: 4 },
        { reason: 'role', count: 2 },
        { reason: 'invalid_row', count: 4 },
      ],
    });
  });
});
