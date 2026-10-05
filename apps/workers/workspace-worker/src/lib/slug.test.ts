import { describe, it, expect } from 'vitest';
import { slugifyWorkspaceName, withRandomSuffix, SLUG_REGEX } from './slug';
import { isClerkSlugError } from './clerk';

describe('slugifyWorkspaceName', () => {
  it('turns a plain name into a readable slug', () => {
    expect(slugifyWorkspaceName('QA Test 2026-09-29')).toBe('qa-test-2026-09-29');
    expect(slugifyWorkspaceName('Acme Industries')).toBe('acme-industries');
  });

  it('folds diacritics to ASCII', () => {
    expect(slugifyWorkspaceName('Café Zürich')).toBe('cafe-zurich');
  });

  it('collapses symbols and trims dashes', () => {
    expect(slugifyWorkspaceName('  --Acme & Sons, Inc.!  ')).toBe('acme-sons-inc');
  });

  it('prefixes names that start with a digit', () => {
    expect(slugifyWorkspaceName('2026 Plans')).toBe('workspace-2026-plans');
  });

  it('prefixes reserved slugs', () => {
    expect(slugifyWorkspaceName('Admin')).toBe('workspace-admin');
    expect(slugifyWorkspaceName('www')).toBe('workspace-www');
    expect(slugifyWorkspaceName('WeldMail')).toBe('workspace-weldmail');
  });

  it('prefixes names shorter than 3 characters', () => {
    expect(slugifyWorkspaceName('Ab')).toBe('workspace-ab');
    expect(slugifyWorkspaceName('X')).toBe('workspace-x');
  });

  it('falls back to "workspace" when nothing usable is left', () => {
    expect(slugifyWorkspaceName('')).toBe('workspace');
    expect(slugifyWorkspaceName('!!! ???')).toBe('workspace');
    expect(slugifyWorkspaceName('工作区')).toBe('workspace');
  });

  it('caps long names without leaving a trailing dash', () => {
    const slug = slugifyWorkspaceName('The Quick Brown Fox Jumps Over The Lazy Dog Again And Again');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('the-quick-brown-fox-jumps-over-the-lazy');

    // The cut lands right after a separator.
    const cutAtDash = slugifyWorkspaceName(`${'a'.repeat(39)} bbbbbb`);
    expect(cutAtDash).toBe('a'.repeat(39));
  });

  it('always produces a valid slug', () => {
    const names = [
      'QA Test 2026-09-29',
      'Café Zürich',
      '2026 Plans',
      'Admin',
      'help',
      '',
      '---',
      'a',
      '😀😀😀',
      'x'.repeat(200),
      '9'.repeat(200),
      'Ünïcödé Nämé 🚀 Ltd.',
    ];
    for (const name of names) {
      expect(slugifyWorkspaceName(name)).toMatch(SLUG_REGEX);
    }
  });
});

describe('withRandomSuffix', () => {
  it('appends a short lowercase alphanumeric suffix and stays valid', () => {
    const slug = withRandomSuffix('qa-test-2026-09-29');
    expect(slug).toMatch(/^qa-test-2026-09-29-[a-z0-9]{5}$/);
    expect(slug).toMatch(SLUG_REGEX);
  });

  it('stays within the slug length limit for the longest base', () => {
    const longest = slugifyWorkspaceName('workspace '.repeat(20));
    expect(withRandomSuffix(longest).length).toBeLessThanOrEqual(63);
  });
});

describe('isClerkSlugError', () => {
  const slugTaken = JSON.stringify({
    errors: [
      {
        message: 'That slug is taken. Please try another.',
        long_message: 'That slug is taken. Please try another.',
        code: 'form_identifier_exists',
        meta: { param_name: 'slug' },
      },
    ],
  });

  it('recognizes a slug rejection', () => {
    expect(isClerkSlugError(422, slugTaken)).toBe(true);
  });

  it('recognizes a slug rejection by message when param_name is missing', () => {
    const body = JSON.stringify({ errors: [{ message: 'slug is invalid', code: 'form_param_format_invalid' }] });
    expect(isClerkSlugError(422, body)).toBe(true);
  });

  it('ignores errors on other fields', () => {
    const body = JSON.stringify({
      errors: [{ message: 'is invalid', code: 'form_param_format_invalid', meta: { param_name: 'created_by' } }],
    });
    expect(isClerkSlugError(422, body)).toBe(false);
  });

  it('ignores server errors, unparseable bodies and empty bodies', () => {
    expect(isClerkSlugError(500, slugTaken)).toBe(false);
    expect(isClerkSlugError(422, 'not json')).toBe(false);
    expect(isClerkSlugError(422, '{}')).toBe(false);
  });
});
