import { describe, expect, it } from 'vitest';
import { emails as en } from '@weldsuite/i18n/locales/en/emails';
import { emails as nl } from '@weldsuite/i18n/locales/nl/emails';
import { accentOf } from './brand';
import type { EmailTemplate } from './define';
import { EMAIL_LOCALES, fill, resolveEmailLocale } from './i18n';
import { renderEmail, renderTemplate } from './render';
import { templates } from './templates';
import { theme } from './theme';

type AnyTemplate = EmailTemplate<unknown>;
const all = Object.entries(templates) as Array<[string, AnyTemplate]>;

/** Every preview of every template, in every locale. */
const cases = all.flatMap(([id, template]) =>
  Object.entries(template.previews).flatMap(([name, preview]) =>
    EMAIL_LOCALES.map((locale) => ({ id, name, locale, template, preview })),
  ),
);

describe.each(cases)('$id / $name / $locale', ({ template, preview, locale }) => {
  it('renders a complete email with no unfilled placeholders', async () => {
    const out = await renderTemplate(template, preview.props, { locale, brand: preview.brand });
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.subject).not.toMatch(/\{\w+\}/);
    expect(out.html.startsWith('<!DOCTYPE html PUBLIC')).toBe(true);
    expect(out.html.match(/<!DOCTYPE/gi)).toHaveLength(1);
    expect(out.html).toMatch(new RegExp(`<html[^>]* lang="${locale}"`));
    expect(out.html).not.toMatch(/<!--\/?\$-->/);
    expect(out.html).not.toContain('rel="preload"');
    expect(out.text).not.toMatch(/\{\w+\}/);
    expect(out.text.length).toBeGreaterThan(20);
  });

  it('matches the text snapshot', async () => {
    const out = await renderTemplate(template, preview.props, { locale, brand: preview.brand });
    expect(`${out.subject}\n\n${out.text}`).toMatchSnapshot();
  });
});

describe('strings', () => {
  const keys = (obj: object, prefix = ''): string[] =>
    Object.entries(obj).flatMap(([k, v]) =>
      typeof v === 'string' ? [`${prefix}${k}`] : keys(v as object, `${prefix}${k}.`),
    );
  const values = (obj: object): string[] =>
    Object.values(obj).flatMap((v) => (typeof v === 'string' ? [v] : values(v as object)));

  it('nl has exactly the en keys', () => {
    expect(keys(nl).sort()).toEqual(keys(en).sort());
  });

  it('has no empty strings', () => {
    for (const v of [...values(en), ...values(nl)]) expect(v.trim()).not.toBe('');
  });
});

describe('renderEmail', () => {
  it('escapes user content', async () => {
    const out = await renderEmail('calendar.event', {
      kind: 'invite',
      organizerName: '<b>Eve</b>',
      title: '<script>alert(1)</script>',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<b>Eve</b>');
  });

  it('puts the subject on one line', async () => {
    const out = await renderEmail('notification', { title: 'Line one\r\nBcc: x@y.z' });
    expect(out.subject).toBe('Line one Bcc: x@y.z');
  });

  it('uses the workspace brand: logo, accent, and "sent via" footer', async () => {
    const out = await renderEmail(
      'notification',
      { title: 'Hello', actionUrl: 'https://app.weldsuite.org/x' },
      { brand: { kind: 'workspace', name: 'Acme', accentColor: '#112233', logoUrl: 'https://acme.test/logo.png' } },
    );
    expect(out.html).toContain('https://acme.test/logo.png');
    expect(out.html).toContain('#112233');
    expect(out.html).not.toContain(theme.logo.url);
    expect(out.text).toContain('Sent via WeldSuite');
  });
});

describe('accentOf', () => {
  it('only accepts hex colors from workspace settings', () => {
    expect(accentOf({ kind: 'workspace', name: 'A', accentColor: '#abc' })).toBe('#abc');
    expect(accentOf({ kind: 'workspace', name: 'A', accentColor: 'red;background:url(x)' })).toBe(theme.color.accent);
    expect(accentOf({ kind: 'weldsuite' })).toBe(theme.color.accent);
  });
});

describe('resolveEmailLocale', () => {
  it('takes the first supported language', () => {
    expect(resolveEmailLocale('nl-NL', 'en')).toBe('nl');
    expect(resolveEmailLocale('fr', 'nl')).toBe('nl');
    expect(resolveEmailLocale(null, undefined)).toBe('en');
    expect(resolveEmailLocale('de')).toBe('en');
  });
});

describe('fill', () => {
  it('fills known placeholders and leaves unknown ones', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });
});
