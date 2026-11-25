/**
 * What the root loader sends to the page about the shop (serialisable; the
 * site document's templates stay on the server, each page gets its own).
 */

import type {
  Menu,
  SectionList,
  ShopAccess,
  ShopChannel,
  ShopData,
  ShopLocale,
  SiteDocument,
  TemplateName,
  ThemeSettings,
} from '@weldsuite/storefront-theme';
import type { PageHead } from './seo';

export interface ShopPayload {
  host: string;
  primaryOrigin: string;
  locale: ShopLocale;
  preview: boolean;
  versionId: string;
  name: string;
  channel: ShopChannel;
  theme: ThemeSettings;
  groups: SiteDocument['groups'];
  /** The `notFound` template, for the 404 page. */
  notFoundSections: SectionList;
  menus: Record<string, Menu>;
  /** The published content pages, for menu links and the legal links. */
  pages: Array<{ id: string; title: string; slug: string }>;
  access: ShopAccess;
  signedIn: boolean;
  /** B2B: the shopper may use quick order, or decide on approvals. */
  b2b: { buyer: boolean; approver: boolean };
  cartCount: number;
  /** WeldPanel, when the merchant turned it on. */
  analytics: { projectKey: string; collectorUrl: string; banner: boolean } | null;
  consent: 'granted' | 'denied' | null;
  /** Origins allowed to drive the preview (preview only). */
  editorOrigins: string[];
  formsPortalUrl: string | null;
  /** The shop's home page head (also the default of other pages). */
  head: PageHead;
}

/** A page drawn from a template's sections. */
export interface TemplatePage {
  template: TemplateName;
  sections: SectionList;
  data: ShopData;
  head: PageHead;
}
