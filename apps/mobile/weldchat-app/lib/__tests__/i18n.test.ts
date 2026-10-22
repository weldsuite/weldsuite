import { en } from '../i18n/locales/en';
import { nl } from '../i18n/locales/nl';
import { interpolate, plural } from '../i18n/interpolate';
import { resolveAppLanguage } from '../i18n/language';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
      (acc, [key, nested]) => ({ ...acc, ...flatten(nested, prefix ? `${prefix}.${key}` : key) }),
      {},
    );
  }
  return { [prefix]: String(value) };
}

function placeholders(text: string): string[] {
  return (text.match(/\{\w+\}/g) ?? []).sort();
}

describe('resolveAppLanguage', () => {
  it('uses Dutch for any Dutch locale', () => {
    expect(resolveAppLanguage('nl')).toBe('nl');
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('nl_BE')).toBe('nl');
  });

  it('falls back to English for everything else', () => {
    expect(resolveAppLanguage('en-GB')).toBe('en');
    expect(resolveAppLanguage('de-DE')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
  });
});

describe('English and Dutch strings', () => {
  it('have the same keys', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('use the same {placeholders} in every string', () => {
    const enLeaves = flatten(en);
    const nlLeaves = flatten(nl);
    for (const [key, text] of Object.entries(enLeaves)) {
      expect({ key, placeholders: placeholders(nlLeaves[key] ?? '') }).toEqual({
        key,
        placeholders: placeholders(text),
      });
    }
  });

  it('translate the tab titles and the channel details actions', () => {
    expect(nl.tabs.directMessages).not.toBe(en.tabs.directMessages);
    expect(nl.tabs.activity).not.toBe(en.tabs.activity);
    expect(nl.tabs.calls).not.toBe(en.tabs.calls);
    expect(nl.channelInfo.leave).not.toBe(en.channelInfo.leave);
    expect(nl.channelInfo.delete).not.toBe(en.channelInfo.delete);
    expect(nl.composer.send).not.toBe(en.composer.send);
  });

  it('keep the tab titles the screen headers use', () => {
    expect(en.tabs.directMessages).toBe('Direct messages');
    expect(en.tabs.activity).toBe('Activity');
  });
});

describe('interpolate and plural', () => {
  it('fills {name}', () => {
    expect(interpolate(en.channel.welcome, { name: 'general' })).toBe('Welcome to #general');
    expect(interpolate(nl.channel.welcome, { name: 'algemeen' })).toBe('Welkom in #algemeen');
  });

  it('picks the singular form for one member', () => {
    expect(plural(1, en.channelInfo.memberCount)).toBe('1 member');
    expect(plural(3, en.channelInfo.memberCount)).toBe('3 members');
    expect(plural(1, nl.channelInfo.memberCount)).toBe('1 lid');
    expect(plural(3, nl.channelInfo.memberCount)).toBe('3 leden');
  });
});
