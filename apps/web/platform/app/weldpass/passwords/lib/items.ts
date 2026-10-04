/**
 * Pure helpers for the WeldPass password manager UI: filtering the item list,
 * deciding what a vault role allows, and shaping the item form.
 *
 * Kept free of React so the rules (who may write where, what a search matches)
 * can be tested directly.
 */

import { z } from 'zod';
import {
  itemInputSchema,
  weldpassItemTypeSchema,
} from '@weldsuite/app-api-client/schemas/weldpass-passwords';
import type {
  WeldPassItem,
  WeldPassItemFields,
  WeldPassItemInput,
  WeldPassItemType,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';

// ---------------------------------------------------------------------------
// Item list
// ---------------------------------------------------------------------------

export type ItemTypeFilter = 'all' | WeldPassItemType;

export interface ItemFilter {
  /** Only this vault's items; omitted or null means every vault. */
  vaultId?: string | null;
  type?: ItemTypeFilter;
  /** Free text. Every word has to match somewhere in title, username, site or URL. */
  query?: string;
}

/**
 * The visible items, sorted by title. Search is client-side over the fields a
 * list carries (never a secret), so a keystroke costs no request.
 */
export function filterItems(items: readonly WeldPassItem[], filter: ItemFilter): WeldPassItem[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

  return items
    .filter((item) => {
      if (filter.vaultId && item.vaultId !== filter.vaultId) return false;
      if (filter.type && filter.type !== 'all' && item.type !== filter.type) return false;
      if (words.length === 0) return true;

      const haystack = [item.title, item.subtitle, item.url, item.host]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** How many items each vault holds, from the already-loaded list. */
export function countByVault(items: readonly WeldPassItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.vaultId, (counts.get(item.vaultId) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------------------
// Vaults and roles
// ---------------------------------------------------------------------------

/** Personal vault first, then shared vaults by name. */
export function sortVaults(vaults: readonly WeldPassVault[]): WeldPassVault[] {
  return [...vaults].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'personal' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Editor and manager can add, change, move and delete items. */
export function canEditVault(vault: WeldPassVault | undefined | null): boolean {
  return vault?.role === 'editor' || vault?.role === 'manager';
}

/**
 * Whether the caller may open the vault's settings to rename it, change who is
 * in it or delete it: its manager, or a workspace admin (`passwords:manage`)
 * who need not be a member. A personal vault never qualifies.
 */
export function canAdministerVault(
  vault: WeldPassVault | undefined | null,
  canManageAll: boolean,
): boolean {
  if (!vault || vault.kind !== 'shared') return false;
  return vault.role === 'manager' || canManageAll;
}

/** An admin looking at a shared vault they are not in: no items, only settings. */
export function isNonMemberView(vault: WeldPassVault | undefined | null): boolean {
  return !!vault && vault.role === null;
}

/** Vaults an item can be created in or moved to. */
export function writableVaults(vaults: readonly WeldPassVault[]): WeldPassVault[] {
  return vaults.filter(canEditVault);
}

/** Move targets: editor or manager on the target, and not where the item already is. */
export function moveTargets(
  vaults: readonly WeldPassVault[],
  currentVaultId: string,
): WeldPassVault[] {
  return writableVaults(vaults).filter((vault) => vault.id !== currentVaultId);
}

/**
 * Where a new item goes by default: the vault being looked at if the caller may
 * write to it, else their personal vault, else the first vault they can write to.
 */
export function defaultCreateVaultId(
  vaults: readonly WeldPassVault[],
  selectedVaultId: string | null | undefined,
): string | undefined {
  const writable = writableVaults(vaults);
  const selected = writable.find((vault) => vault.id === selectedVaultId);
  if (selected) return selected.id;
  return (writable.find((vault) => vault.kind === 'personal') ?? writable[0])?.id;
}

// ---------------------------------------------------------------------------
// Two-factor codes
// ---------------------------------------------------------------------------

/** Whole seconds until `expiresAt`, never negative. */
export function secondsUntil(expiresAt: string, now: number = Date.now()): number {
  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(expires)) return 0;
  return Math.max(0, Math.ceil((expires - now) / 1000));
}

/** "123456" -> "123 456": easier to read and type. Other lengths are split in the middle. */
export function formatTotpCode(code: string): string {
  if (code.length < 4) return code;
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

// ---------------------------------------------------------------------------
// Item form
// ---------------------------------------------------------------------------

/** Every field of every type, flat, so one form can edit any of them. */
export interface ItemFormValues {
  type: WeldPassItemType;
  vaultId: string;
  title: string;
  url: string;
  username: string;
  password: string;
  totp: string;
  notes: string;
  content: string;
  cardholder: string;
  number: string;
  expiry: string;
  cvc: string;
}

export function emptyItemForm(
  type: WeldPassItemType,
  vaultId: string,
): ItemFormValues {
  return {
    type,
    vaultId,
    title: '',
    url: '',
    username: '',
    password: '',
    totp: '',
    notes: '',
    content: '',
    cardholder: '',
    number: '',
    expiry: '',
    cvc: '',
  };
}

/** Prefill the form from a revealed item, for editing. */
export function itemToFormValues(
  item: Pick<WeldPassItem, 'type' | 'vaultId' | 'title' | 'url'>,
  fields: WeldPassItemFields,
): ItemFormValues {
  const values = emptyItemForm(item.type, item.vaultId);
  values.title = item.title;
  values.url = item.url ?? '';

  if ('username' in fields) {
    values.username = fields.username;
    values.password = fields.password;
    values.totp = fields.totp;
    values.notes = fields.notes;
  } else if ('content' in fields) {
    values.content = fields.content;
  } else {
    values.cardholder = fields.cardholder;
    values.number = fields.number;
    values.expiry = fields.expiry;
    values.cvc = fields.cvc;
    values.notes = fields.notes;
  }
  return values;
}

/**
 * Client-side validation for the form. The server's `itemInputSchema` stays
 * the authority; this only catches the empty title before a round trip and
 * lets the form show its message in the user's language.
 */
export function createItemFormSchema(messages: { titleRequired: string }) {
  return z.object({
    type: weldpassItemTypeSchema,
    vaultId: z.string().min(1),
    title: z.string().trim().min(1, messages.titleRequired).max(200),
    url: z.string().trim().max(2048),
    username: z.string().max(255),
    password: z.string().max(4096),
    totp: z.string().trim().max(2048),
    notes: z.string().max(20_000),
    content: z.string().max(100_000),
    cardholder: z.string().trim().max(255),
    number: z.string().trim().max(40),
    expiry: z.string().trim().max(10),
    cvc: z.string().trim().max(10),
  });
}

/**
 * The whole item the API takes. Only the fields of the chosen type are sent,
 * so a login never carries a stale card number from a type that was switched
 * away from before saving.
 */
export function toItemInput(values: ItemFormValues): WeldPassItemInput {
  const title = values.title.trim();

  switch (values.type) {
    case 'login':
      return itemInputSchema.parse({
        type: 'login',
        title,
        url: values.url.trim() || null,
        fields: {
          username: values.username,
          password: values.password,
          totp: values.totp,
          notes: values.notes,
        },
      });
    case 'note':
      return itemInputSchema.parse({
        type: 'note',
        title,
        fields: { content: values.content },
      });
    case 'card':
      return itemInputSchema.parse({
        type: 'card',
        title,
        fields: {
          cardholder: values.cardholder,
          number: values.number,
          expiry: values.expiry,
          cvc: values.cvc,
          notes: values.notes,
        },
      });
  }
}

/**
 * A link target for the item's URL. The stored URL may lack a scheme
 * ("example.com/login"); anything that is not http(s) is refused so a
 * `javascript:` URL saved in an item can never become a link.
 */
export function safeHref(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
