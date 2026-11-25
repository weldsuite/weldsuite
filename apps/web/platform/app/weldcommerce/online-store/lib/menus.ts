/**
 * Menus of an online store in the menu editor: the form's values (an item's
 * link as a type and one target field), the conversion to and from the API's
 * `MenuItem`s, and the schema (a label, a target for the link types that need
 * one, one level of sub-links, 100 links at most).
 */

import { z } from 'zod';
import { LIMITS, type MenuItem, type MenuLink } from '@weldsuite/storefront-theme/catalog';
import { getTranslations } from '@/lib/i18n';
import { uniqueId } from './document';
import { isSafeUrl } from './settings-schema';

export const LINK_TYPES = ['home', 'catalog', 'cart', 'account', 'search', 'category', 'product', 'page', 'url'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** The menus every store has; they can be emptied but not deleted. */
export const BUILT_IN_MENUS = ['main', 'footer'];
export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MenuFormLink {
  /** The item's id in the menu (kept across edits). */
  itemId: string;
  label: string;
  linkType: LinkType;
  /** A category, product or page id, or the URL; empty for the other types. */
  target: string;
}

export interface MenuFormItem extends MenuFormLink {
  children: MenuFormLink[];
}

export interface MenuFormValues {
  title: string;
  items: MenuFormItem[];
}

export function needsTarget(type: LinkType): boolean {
  return type === 'category' || type === 'product' || type === 'page' || type === 'url';
}

function linkTarget(link: MenuLink): string {
  if (link.type === 'url') return link.url;
  if (link.type === 'category' || link.type === 'product' || link.type === 'page') return link.id;
  return '';
}

function toFormLink(item: MenuItem): MenuFormLink {
  return { itemId: item.id, label: item.label, linkType: item.link.type, target: linkTarget(item.link) };
}

export function toMenuFormValues(menu: { title: string; items: MenuItem[] }): MenuFormValues {
  return {
    title: menu.title,
    items: menu.items.map((item) => ({ ...toFormLink(item), children: (item.children ?? []).map(toFormLink) })),
  };
}

function toLink(value: MenuFormLink): MenuLink {
  const target = value.target.trim();
  switch (value.linkType) {
    case 'url':
      return { type: 'url', url: target };
    case 'category':
    case 'product':
    case 'page':
      return { type: value.linkType, id: target };
    default:
      return { type: value.linkType };
  }
}

/** The API's items; ids stay, new items get one unique in the menu. */
export function toMenuItems(values: MenuFormValues): MenuItem[] {
  const taken = new Set<string>();
  for (const item of values.items) {
    if (item.itemId) taken.add(item.itemId);
    for (const child of item.children) if (child.itemId) taken.add(child.itemId);
  }
  const idFor = (link: MenuFormLink) => {
    if (link.itemId) return link.itemId;
    const id = uniqueId(link.label || 'link', taken);
    taken.add(id);
    return id;
  };
  return values.items.map((item) => {
    const menuItem: MenuItem = { id: idFor(item), label: item.label.trim(), link: toLink(item) };
    if (item.children.length > 0) {
      menuItem.children = item.children.map((child) => ({ id: idFor(child), label: child.label.trim(), link: toLink(child) }));
    }
    return menuItem;
  });
}

export function emptyLink(): MenuFormLink {
  return { itemId: '', label: '', linkType: 'catalog', target: '' };
}

export function countLinks(items: readonly MenuFormItem[]): number {
  return items.reduce((total, item) => total + 1 + item.children.length, 0);
}

export function buildMenuSchema() {
  const t = getTranslations('commerce').onlineStore.menus;
  const linkShape = {
    itemId: z.string(),
    label: z.string().trim().min(1, t.labelRequired).max(200),
    linkType: z.enum(LINK_TYPES),
    target: z.string().trim().max(2000),
  };
  const checkTarget = (value: { linkType: LinkType; target: string }, ctx: z.RefinementCtx) => {
    if (!needsTarget(value.linkType)) return;
    if (value.target === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: t.targetRequired });
    else if (value.linkType === 'url' && !isSafeUrl(value.target)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: t.urlInvalid });
  };
  const child = z.object(linkShape).superRefine(checkTarget);
  const item = z.object({ ...linkShape, children: z.array(child) }).superRefine(checkTarget);
  return z
    .object({
      title: z.string().trim().min(1, t.titleRequired).max(200),
      items: z.array(item),
    })
    .superRefine((values, ctx) => {
      if (countLinks(values.items) > LIMITS.menuItems) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: t.tooMany });
    });
}

export function buildNewMenuSchema(existing: readonly string[]) {
  const t = getTranslations('commerce').onlineStore.menus;
  return z.object({
    handle: z
      .string()
      .trim()
      .min(1, t.handleInvalid)
      .max(40, t.handleInvalid)
      .regex(HANDLE_PATTERN, t.handleInvalid)
      .refine((value) => !existing.includes(value), t.handleTaken),
    title: z.string().trim().min(1, t.titleRequired).max(200),
  });
}
