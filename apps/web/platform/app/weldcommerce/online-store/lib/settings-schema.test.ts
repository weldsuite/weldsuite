import { describe, expect, it } from 'vitest';
import { SECTION_CATALOG, type SettingDefinition } from '@weldsuite/storefront-theme/catalog';
import { formValues, isImageUrl, isSafeUrl, isVideoUrl, settingSchema, settingsSchema } from './settings-schema';
import { parseFieldPath, settingErrors } from './field-errors';

const def = (over: Partial<SettingDefinition> & Pick<SettingDefinition, 'type'>): SettingDefinition => ({
  id: 'x',
  label: { en: 'X', nl: 'X' },
  default: '',
  ...over,
});

describe('URLs', () => {
  it('accepts shop paths and https, mailto and tel addresses only', () => {
    for (const ok of ['/products', '/pages/about', 'https://example.com/x', 'mailto:hello@example.com', 'tel:+31200000000']) expect(isSafeUrl(ok), ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'http://example.com', '//evil.example', 'data:text/html,x', 'example.com', '/with space']) expect(isSafeUrl(bad), bad).toBe(false);
  });

  it('accepts images by https or shop path, and videos from YouTube or Vimeo', () => {
    expect(isImageUrl('https://cdn.example.com/a.jpg')).toBe(true);
    expect(isImageUrl('/logo.png')).toBe(true);
    expect(isImageUrl('mailto:x@example.com')).toBe(false);
    expect(isVideoUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isVideoUrl('https://vimeo.com/123')).toBe(true);
    expect(isVideoUrl('https://example.com/video.mp4')).toBe(false);
  });
});

describe('a setting’s schema', () => {
  it('limits text to its maximum length, and rich text to 20,000 by default', () => {
    const heading = settingSchema(def({ type: 'text', maxLength: 5 }));
    expect(heading.safeParse('Hello').success).toBe(true);
    const result = heading.safeParse('Hello!');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Use at most 5 characters.');
    expect(settingSchema(def({ type: 'richtext' })).safeParse('x'.repeat(20000)).success).toBe(true);
    expect(settingSchema(def({ type: 'richtext' })).safeParse('x'.repeat(20001)).success).toBe(false);
    expect(settingSchema(def({ type: 'text' })).safeParse('x'.repeat(2001)).success).toBe(false);
  });

  it('keeps numbers within their range', () => {
    const schema = settingSchema(def({ type: 'number', min: 8, max: 48, default: 24 }));
    expect(schema.safeParse(24).success).toBe(true);
    expect(schema.safeParse(7).error?.issues[0]?.message).toBe('Enter a number from 8 to 48.');
    expect(schema.safeParse(undefined).error?.issues[0]?.message).toBe('Enter a number from 8 to 48.');
  });

  it('only takes a select’s own options, booleans for a checkbox, lists for multi-pickers', () => {
    const align = SECTION_CATALOG['rich-text']!.settings.find((setting) => setting.id === 'align')!;
    expect(settingSchema(align).safeParse('center').success).toBe(true);
    expect(settingSchema(align).safeParse('right').success).toBe(false);
    expect(settingSchema(def({ type: 'checkbox', default: false })).safeParse('yes').success).toBe(false);
    expect(settingSchema(def({ type: 'products', default: [] })).safeParse(['prod_1']).success).toBe(true);
  });

  it('wants a colour as #rrggbb, and never empty where the setting has one', () => {
    expect(settingSchema(def({ type: 'color', default: '#ffffff' })).safeParse('#1f2937').success).toBe(true);
    expect(settingSchema(def({ type: 'color', default: '#ffffff' })).safeParse('').success).toBe(false);
    expect(settingSchema(def({ type: 'color', default: '' })).safeParse('').success).toBe(true);
    expect(settingSchema(def({ type: 'color', default: '' })).safeParse('red').success).toBe(false);
  });

  it('checks URL, image and video settings, and lets them be empty', () => {
    expect(settingSchema(def({ type: 'url' })).safeParse('').success).toBe(true);
    expect(settingSchema(def({ type: 'url' })).safeParse('javascript:alert(1)').success).toBe(false);
    expect(settingSchema(def({ type: 'image' })).safeParse('tel:123').success).toBe(false);
    expect(settingSchema(def({ type: 'video' })).safeParse('https://example.com').success).toBe(false);
  });

  it('accepts the defaults of every setting in the catalog', () => {
    for (const [type, definition] of Object.entries(SECTION_CATALOG)) {
      const all = [...definition.settings, ...Object.values(definition.blocks).flatMap((block) => block.settings)];
      for (const setting of all) expect(settingSchema(setting).safeParse(setting.default).success, `${type}.${setting.id}`).toBe(true);
    }
  });
});

describe('form values', () => {
  it('fills in defaults for missing values and values of the wrong type', () => {
    const definitions = SECTION_CATALOG.hero!.settings;
    const values = formValues(definitions, { heading: 'Hi', overlay: 'lots' });
    expect(values.heading).toBe('Hi');
    expect(values.overlay).toBe(30);
    expect(values.buttonLink).toBe('/products');
    expect(Object.keys(values)).toEqual(definitions.map((definition) => definition.id));
    expect(settingsSchema(definitions).safeParse(values).success).toBe(true);
  });
});

describe('validation error paths', () => {
  it('reads dotted, bracketed and pointer paths', () => {
    expect(parseFieldPath('templates.home.2.settings.heading')).toEqual({ list: 'home', sectionIndex: 2, settingId: 'heading' });
    expect(parseFieldPath('templates.home[2].settings.heading')).toEqual({ list: 'home', sectionIndex: 2, settingId: 'heading' });
    expect(parseFieldPath('/groups/header/0/settings/menu')).toEqual({ list: 'header', sectionIndex: 0, settingId: 'menu' });
    expect(parseFieldPath('document.templates.page[0].blocks[3].settings.answer')).toEqual({
      list: 'page',
      sectionIndex: 0,
      blockIndex: 3,
      settingId: 'answer',
    });
    expect(parseFieldPath('sections.1.settings.text')).toEqual({ list: 'content', sectionIndex: 1, settingId: 'text' });
    expect(parseFieldPath('theme.settings.colors.primary')).toEqual({ area: 'theme', settingId: 'colors.primary' });
    expect(parseFieldPath('seo.title')).toEqual({ area: 'seo', settingId: 'title' });
    expect(parseFieldPath('something.else')).toEqual({});
  });

  it('picks the errors of one section or block by setting id', () => {
    const fields = {
      'templates.home[1].settings.heading': 'Too long',
      'templates.home[1].blocks[0].settings.title': 'Required',
      'templates.home[2].settings.heading': 'Other section',
      'groups.header[1].settings.heading': 'Other list',
    };
    expect(settingErrors(fields, { list: 'home', sectionIndex: 1 })).toEqual({ heading: 'Too long' });
    expect(settingErrors(fields, { list: 'home', sectionIndex: 1, blockIndex: 0 })).toEqual({ title: 'Required' });
  });
});
