/**
 * The Theme settings and Shop settings panels of the editor. Both are
 * generated forms like a section's (`SettingsForm`): their fields are
 * written as setting definitions here and map onto the document's
 * `theme.settings`, `seo` and `settings`.
 */

import { useCallback, useMemo } from 'react';
import {
  THEME_FONTS,
  THEME_PRESETS,
  presetSettings,
  type SettingDefinition,
  type SettingValue,
  type SettingValues,
  type ShopAccess,
  type SiteDocument,
  type SocialLinks,
  type ThemeColors,
  type ThemeSettings,
} from '@weldsuite/storefront-theme/catalog';
import { getTranslations } from '@/lib/i18n';
import type { ThemeLabel } from '../lib/labels';
import { useEditorContent, useEditorDispatch } from './editor-state';
import { SettingsForm } from './settings-form';

/** A label already in the platform language. */
const text = (value: string): ThemeLabel => ({ en: value, nl: value });

const COLOR_KEYS: (keyof ThemeColors)[] = ['background', 'foreground', 'primary', 'primaryForeground', 'muted', 'border'];
const SOCIAL_KEYS: (keyof SocialLinks)[] = ['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'youtube', 'pinterest'];
const RADII: ThemeSettings['radius'][] = ['none', 'small', 'medium', 'large'];
const ACCESS: ShopAccess[] = ['public', 'prices_signed_in', 'signed_in'];

function themeDefinitions(): SettingDefinition[] {
  const t = getTranslations('commerce').onlineStore.theme;
  const fontOptions = THEME_FONTS.map((font) => ({ value: font.id, label: text(font.name) }));
  return [
    {
      id: 'preset',
      type: 'select',
      label: text(t.preset),
      help: text(t.presetHint),
      default: THEME_PRESETS[0]?.id ?? '',
      options: THEME_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
    },
    ...COLOR_KEYS.map((key): SettingDefinition => ({ id: `color.${key}`, type: 'color', label: text(t.color[key]), default: '#000000' })),
    { id: 'fontHeading', type: 'select', label: text(t.fontHeading), default: 'inter', options: fontOptions },
    { id: 'fontBody', type: 'select', label: text(t.fontBody), default: 'inter', options: fontOptions },
    {
      id: 'radius',
      type: 'select',
      label: text(t.radius),
      default: 'small',
      options: RADII.map((radius) => ({ value: radius, label: text(t.radiusOptions[radius]) })),
    },
    { id: 'logoUrl', type: 'image', label: text(t.logoUrl), default: '' },
    { id: 'logoAlt', type: 'text', label: text(t.logoAlt), help: text(t.logoAltHint), default: '', maxLength: 200 },
    { id: 'faviconUrl', type: 'image', label: text(t.faviconUrl), help: text(t.faviconHint), default: '' },
    ...SOCIAL_KEYS.map((key): SettingDefinition => ({ id: `social.${key}`, type: 'url', label: text(t.networks[key]), default: '' })),
  ];
}

/** Form ids use `_` where the document nests (`color.primary` → `color_primary`): React Hook Form reads dots as paths. */
const formId = (id: string) => id.replace('.', '_');

function withFormIds(definitions: SettingDefinition[]): SettingDefinition[] {
  return definitions.map((definition) => ({ ...definition, id: formId(definition.id) }));
}

function themeValues(settings: ThemeSettings): SettingValues {
  const values: SettingValues = {
    preset: settings.preset,
    fontHeading: settings.fontHeading,
    fontBody: settings.fontBody,
    radius: settings.radius,
    logoUrl: settings.logoUrl ?? '',
    logoAlt: settings.logoAlt ?? '',
    faviconUrl: settings.faviconUrl ?? '',
  };
  for (const key of COLOR_KEYS) values[formId(`color.${key}`)] = settings.colors[key];
  for (const key of SOCIAL_KEYS) values[formId(`social.${key}`)] = settings.social?.[key] ?? '';
  return values;
}

/** The theme settings with one form field changed; a new style brings its colours, fonts and corners. */
export function applyThemeField(settings: ThemeSettings, id: string, value: SettingValue): ThemeSettings {
  const stringValue = typeof value === 'string' ? value : '';
  if (id === 'preset') {
    const preset = presetSettings(stringValue);
    return { ...settings, preset: preset.preset, colors: preset.colors, fontHeading: preset.fontHeading, fontBody: preset.fontBody, radius: preset.radius };
  }
  const color = COLOR_KEYS.find((key) => formId(`color.${key}`) === id);
  if (color) return { ...settings, colors: { ...settings.colors, [color]: stringValue } };
  const network = SOCIAL_KEYS.find((key) => formId(`social.${key}`) === id);
  if (network) {
    const social = { ...settings.social };
    if (stringValue) social[network] = stringValue;
    else delete social[network];
    return { ...settings, social };
  }
  if (id === 'radius') return { ...settings, radius: stringValue as ThemeSettings['radius'] };
  if (id === 'logoUrl' || id === 'logoAlt' || id === 'faviconUrl') return { ...settings, [id]: stringValue || null };
  if (id === 'fontHeading' || id === 'fontBody') return { ...settings, [id]: stringValue };
  return settings;
}

function shopDefinitions(): SettingDefinition[] {
  const t = getTranslations('commerce').onlineStore.shop;
  return [
    { id: 'seoTitle', type: 'text', label: text(t.seoTitle), help: text(t.seoTitleHint), default: '', maxLength: 200 },
    { id: 'seoDescription', type: 'textarea', label: text(t.seoDescription), default: '', maxLength: 500 },
    { id: 'seoImage', type: 'image', label: text(t.seoImage), help: text(t.seoImageHint), default: '' },
    {
      id: 'access',
      type: 'select',
      label: text(t.access),
      default: 'public',
      options: ACCESS.map((access) => ({ value: access, label: text(t.accessOptions[access]) })),
    },
    { id: 'analyticsKey', type: 'text', label: text(t.analyticsKey), help: text(t.analyticsKeyHint), default: '', maxLength: 200 },
    { id: 'cookieBanner', type: 'checkbox', label: text(t.cookieBanner), help: text(t.cookieBannerHint), default: false },
  ];
}

function shopValues(document: SiteDocument): SettingValues {
  return {
    seoTitle: document.seo.title ?? '',
    seoDescription: document.seo.description ?? '',
    seoImage: document.seo.imageUrl ?? '',
    access: document.settings.access,
    analyticsKey: document.settings.analytics?.weldpanelProjectKey ?? '',
    cookieBanner: document.settings.cookieBanner,
  };
}

const SEO_FIELDS = { seoTitle: 'title', seoDescription: 'description', seoImage: 'imageUrl' } as const;

/** The document with one Shop settings field changed; an emptied text is left out. */
export function applyShopField(document: SiteDocument, id: string, value: SettingValue): SiteDocument {
  const stringValue = typeof value === 'string' ? value.trim() : '';
  if (id in SEO_FIELDS) {
    const key = SEO_FIELDS[id as keyof typeof SEO_FIELDS];
    const seo = { ...document.seo };
    if (stringValue) seo[key] = stringValue;
    else delete seo[key];
    return { ...document, seo };
  }
  if (id === 'access') return { ...document, settings: { ...document.settings, access: stringValue as ShopAccess } };
  if (id === 'cookieBanner') return { ...document, settings: { ...document.settings, cookieBanner: value === true } };
  if (id === 'analyticsKey') {
    const analytics = { ...document.settings.analytics };
    if (stringValue) analytics.weldpanelProjectKey = stringValue;
    else delete analytics.weldpanelProjectKey;
    const { analytics: _previous, ...rest } = document.settings;
    return { ...document, settings: Object.keys(analytics).length === 0 ? rest : { ...rest, analytics } };
  }
  return document;
}

interface FormGroup {
  title: string;
  description?: string;
  /** A group of one field whose label says it all. */
  untitled?: boolean;
  ids: string[];
}

/** The groups of a long panel, each a form of its own under a heading; all edit the same values. */
function GroupedForms({
  groups,
  definitions,
  values,
  onChange,
  readOnly,
  siteId,
}: Readonly<{
  groups: FormGroup[];
  definitions: SettingDefinition[];
  values: SettingValues;
  onChange: (id: string, value: SettingValue) => void;
  readOnly: boolean;
  siteId: string;
}>) {
  const parts = useMemo(
    () => groups.map((group) => ({ ...group, definitions: definitions.filter((definition) => group.ids.includes(definition.id)) })),
    [groups, definitions],
  );
  return (
    <div className="space-y-6">
      {parts.map((group) => (
        <section key={group.title} className="space-y-3">
          {!group.untitled && (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{group.title}</h3>
              {group.description && <p className="text-xs text-muted-foreground">{group.description}</p>}
            </div>
          )}
          <SettingsForm definitions={group.definitions} values={values} onChange={onChange} readOnly={readOnly} siteId={siteId} label={group.title} />
        </section>
      ))}
    </div>
  );
}

export function ThemePanel({ siteId, readOnly }: Readonly<{ siteId: string; readOnly: boolean }>) {
  const t = getTranslations('commerce').onlineStore.theme;
  const content = useEditorContent();
  const dispatch = useEditorDispatch();
  const definitions = useMemo(() => withFormIds(themeDefinitions()), []);
  const groups = useMemo<FormGroup[]>(
    () => [
      { title: t.preset, untitled: true, ids: ['preset'] },
      { title: t.colors, ids: COLOR_KEYS.map((key) => formId(`color.${key}`)) },
      { title: t.fonts, ids: ['fontHeading', 'fontBody', 'radius'] },
      { title: t.brand, ids: ['logoUrl', 'logoAlt', 'faviconUrl'] },
      { title: t.social, description: t.socialHint, ids: SOCIAL_KEYS.map((key) => formId(`social.${key}`)) },
    ],
    [t],
  );
  const settings = content.document.theme.settings;
  const values = useMemo(() => themeValues(settings), [settings]);
  const onChange = useCallback(
    (id: string, value: SettingValue) =>
      dispatch({
        type: 'change',
        coalesceKey: `theme:${id}`,
        update: (current) => {
          const next = applyThemeField(current.document.theme.settings, id, value);
          if (JSON.stringify(next) === JSON.stringify(current.document.theme.settings)) return current;
          return { ...current, document: { ...current.document, theme: { ...current.document.theme, settings: next } } };
        },
      }),
    [dispatch],
  );
  return <GroupedForms groups={groups} definitions={definitions} values={values} onChange={onChange} readOnly={readOnly} siteId={siteId} />;
}

export function ShopPanel({ siteId, readOnly }: Readonly<{ siteId: string; readOnly: boolean }>) {
  const t = getTranslations('commerce').onlineStore.shop;
  const content = useEditorContent();
  const dispatch = useEditorDispatch();
  const definitions = useMemo(() => shopDefinitions(), []);
  const groups = useMemo<FormGroup[]>(
    () => [
      { title: t.seo, ids: ['seoTitle', 'seoDescription', 'seoImage'] },
      { title: t.access, untitled: true, ids: ['access'] },
      { title: t.analytics, ids: ['analyticsKey', 'cookieBanner'] },
    ],
    [t],
  );
  const values = useMemo(() => shopValues(content.document), [content.document]);
  const onChange = useCallback(
    (id: string, value: SettingValue) =>
      dispatch({
        type: 'change',
        coalesceKey: `shop:${id}`,
        update: (current) => {
          const next = applyShopField(current.document, id, value);
          return JSON.stringify(shopValues(next)) === JSON.stringify(shopValues(current.document)) ? current : { ...current, document: next };
        },
      }),
    [dispatch],
  );
  return <GroupedForms groups={groups} definitions={definitions} values={values} onChange={onChange} readOnly={readOnly} siteId={siteId} />;
}
