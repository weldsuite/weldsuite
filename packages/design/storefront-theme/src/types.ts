/**
 * The site document of a WeldCommerce online store: what the editor edits
 * (the draft) and what the renderer draws (a published version). The backend
 * validates every draft against the section catalog exported from
 * `catalog.ts` (`rust/catalogs/storefront-sections.json`).
 */

/** The page types a theme draws, each from its own list of sections. */
export const TEMPLATE_NAMES = ['home', 'product', 'category', 'search', 'cart', 'page', 'notFound'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** The lists shared by every page. */
export const GROUP_NAMES = ['header', 'footer'] as const;
export type GroupName = (typeof GROUP_NAMES)[number];

/** Where a section list lives: a template, a group, or a content page's own sections (`content`). */
export type ListName = TemplateName | GroupName | 'content';

/** The languages a shop can be in. */
export const SHOP_LOCALES = ['en', 'nl', 'de', 'fr'] as const;
export type ShopLocale = (typeof SHOP_LOCALES)[number];

export type SettingValue = string | number | boolean | null | string[];
export type SettingValues = Record<string, SettingValue>;

export interface Block {
  id: string;
  type: string;
  settings: SettingValues;
}

export interface Section {
  /** `[a-z0-9_-]{1,40}`, unique within its list. */
  id: string;
  /** A key of the section catalog. */
  type: string;
  hidden?: boolean;
  settings: SettingValues;
  blocks?: Block[];
}

export type SectionList = Section[];

export type Radius = 'none' | 'small' | 'medium' | 'large';

export interface ThemeColors {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  border: string;
}

export interface SocialLinks {
  instagram?: string;
  facebook?: string;
  x?: string;
  linkedin?: string;
  tiktok?: string;
  youtube?: string;
  pinterest?: string;
}

export interface ThemeSettings {
  /** A preset id of the theme ([`THEME_PRESETS`]). */
  preset: string;
  colors: ThemeColors;
  /** Font ids the theme bundles ([`THEME_FONTS`]): self-hosted, never a font CDN. */
  fontHeading: string;
  fontBody: string;
  radius: Radius;
  logoUrl?: string | null;
  logoAlt?: string | null;
  faviconUrl?: string | null;
  social?: SocialLinks;
}

/** Who sees what (B2B shops often show the catalogue to signed-in buyers only). */
export type ShopAccess = 'public' | 'prices_signed_in' | 'signed_in';

export interface SiteSettings {
  access: ShopAccess;
  analytics?: { weldpanelProjectKey?: string; collectorUrl?: string };
  /** Show the consent banner; only needed when something non-essential runs. */
  cookieBanner: boolean;
}

export interface SiteSeo {
  title?: string;
  description?: string;
  imageUrl?: string;
}

export interface SiteDocument {
  schemaVersion: 1;
  theme: { id: string; settings: ThemeSettings };
  templates: Record<TemplateName, SectionList>;
  groups: Record<GroupName, SectionList>;
  seo: SiteSeo;
  settings: SiteSettings;
}

export type MenuLink =
  | { type: 'home' | 'cart' | 'account' | 'search' | 'catalog' }
  | { type: 'category' | 'product' | 'page'; id: string }
  | { type: 'url'; url: string };

export interface MenuItem {
  id: string;
  label: string;
  link: MenuLink;
  /** One level deep at most. */
  children?: MenuItem[];
}

export interface Menu {
  title: string;
  items: MenuItem[];
}

export interface PublishedPage {
  id: string;
  title: string;
  slug: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  sections: SectionList;
}

/** A published version: the site document with its pages, menus and redirects. */
export interface PublishedDocument extends SiteDocument {
  pages: PublishedPage[];
  menus: Record<string, Menu>;
  redirects: { fromPath: string; toPath: string }[];
}

/** Limits the backend enforces too (`rust/modules/commerce/src/online_store`). */
export const LIMITS = {
  sectionsPerList: 40,
  blocksPerSection: 50,
  idLength: 40,
  textLength: 2000,
  richTextLength: 20000,
  documentBytes: 512 * 1024,
  menuItems: 100,
  menuDepth: 2,
} as const;

export const SECTION_ID = /^[a-z0-9_-]{1,40}$/;
