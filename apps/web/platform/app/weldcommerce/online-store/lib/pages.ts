/**
 * Content pages of an online store: slugs, the create form's values from a
 * page template, and the form schemas.
 */

import { z } from 'zod';
import { PAGE_TEMPLATES, type PageTemplate, type ShopLocale } from '@weldsuite/storefront-theme/catalog';
import type { CreatePageInput, StorePage, UpdatePageInput } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from '@/app/weldcommerce/lib/text';
import { trimHyphens } from './document';
import type { ThemeLabel } from './labels';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 100;

/** A slug from a title: lowercase ASCII letters and digits joined by hyphens. */
export function slugify(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  // Trimmed again after the cut, which can end on a hyphen.
  return trimHyphens(trimHyphens(words).slice(0, SLUG_MAX));
}

/** A template's text in the shop's language: Dutch for a Dutch shop, English otherwise (the templates come in en and nl). */
export function inShopLanguage(label: ThemeLabel, locale: ShopLocale): string {
  return locale === 'nl' ? label.nl : label.en;
}

export function findPageTemplate(id: string): PageTemplate {
  return PAGE_TEMPLATES.find((template) => template.id === id) ?? PAGE_TEMPLATES[0]!;
}

export interface NewPageValues {
  template: string;
  title: string;
  slug: string;
}

export function newPageValues(templateId: string, locale: ShopLocale): NewPageValues {
  const template = findPageTemplate(templateId);
  return { template: template.id, title: inShopLanguage(template.title, locale), slug: template.slug };
}

export function buildNewPageSchema() {
  const t = getTranslations('commerce').onlineStore.pages.form;
  return z.object({
    template: z.string(),
    title: z.string().trim().min(1, t.titleRequired).max(200),
    slug: z
      .string()
      .trim()
      .max(SLUG_MAX)
      .refine((value) => value === '' || SLUG_PATTERN.test(value), t.slugInvalid),
  });
}

/** The create body: the title, the slug (or one made from the title), and the template's sections. */
export function toCreatePageInput(values: NewPageValues): CreatePageInput {
  const title = values.title.trim();
  const slug = values.slug.trim() || slugify(title);
  const body: CreatePageInput = { title, sections: findPageTemplate(values.template).sections() };
  if (slug) body.slug = slug;
  return body;
}

export interface PageSettingsValues {
  title: string;
  slug: string;
  seoTitle: string;
  seoDescription: string;
  visible: boolean;
}

export function pageSettingsValues(page: StorePage): PageSettingsValues {
  return {
    title: page.title,
    slug: page.slug,
    seoTitle: page.seoTitle ?? '',
    seoDescription: page.seoDescription ?? '',
    visible: page.visible,
  };
}

export function buildPageSettingsSchema() {
  const t = getTranslations('commerce').onlineStore.pages.form;
  const tooLong = getTranslations('commerce').onlineStore.validation.tooLong;
  return z.object({
    title: z.string().trim().min(1, t.titleRequired).max(200),
    slug: z.string().trim().min(1, t.slugInvalid).max(SLUG_MAX).regex(SLUG_PATTERN, t.slugInvalid),
    seoTitle: z.string().trim().max(200, fill(tooLong, { max: 200 })),
    seoDescription: z.string().trim().max(500, fill(tooLong, { max: 500 })),
    visible: z.boolean(),
  });
}

export function toUpdatePageInput(values: PageSettingsValues): UpdatePageInput {
  return {
    title: values.title.trim(),
    slug: values.slug.trim(),
    seoTitle: values.seoTitle.trim() || null,
    seoDescription: values.seoDescription.trim() || null,
    visible: values.visible,
  };
}
