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

/** Filter field ids shared by the item list's filter pills and the `?vault=` link. */
export const VAULT_FILTER = 'vault';
export const TYPE_FILTER = 'type';

/** The shape of an active filter pill in the shared entity list. */
export interface FilterPill {
  id: string;
  field: string;
  /** "is" or "is not" for the select filters used here. Empty until picked. */
  operator: string;
  /** Empty until picked. */
  value: string;
}

export interface ItemFilter {
  pills?: readonly FilterPill[];
  /** Free text. Every word has to match somewhere in title, username, site or URL. */
  query?: string;
}

/** A pill counts only once both its operator and its value are chosen. */
function isComplete(pill: FilterPill): boolean {
  return pill.operator !== '' && pill.value !== '';
}

/** Whether the pills that apply to `field` accept `value`. Other fields are ignored. */
function pillsAccept(pills: readonly FilterPill[], field: string, value: string): boolean {
  return pills
    .filter((pill) => pill.field === field && isComplete(pill))
    .every((pill) => (pill.operator === 'is not' ? value !== pill.value : value === pill.value));
}

/**
 * The visible items, sorted by title. The entity list hands over its filter
 * pills and search text and leaves the matching to us: search is client-side
 * over the fields a list carries (never a secret), so a keystroke costs no
 * request.
 */
export function filterItems(items: readonly WeldPassItem[], filter: ItemFilter): WeldPassItem[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const pills = filter.pills ?? [];

  return items
    .filter((item) => {
      if (!pillsAccept(pills, VAULT_FILTER, item.vaultId)) return false;
      if (!pillsAccept(pills, TYPE_FILTER, item.type)) return false;
      if (words.length === 0) return true;

      const haystack = [item.title, item.subtitle, item.url, item.host]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** Whether a search or any chosen filter is narrowing the list. */
export function isFiltering(filter: ItemFilter): boolean {
  return (filter.query ?? '').trim() !== '' || (filter.pills ?? []).some(isComplete);
}

/** The vault the list is narrowed to ("vault is X"), if any. */
export function vaultIdFromPills(pills: readonly FilterPill[]): string | undefined {
  return pills.find((pill) => pill.field === VAULT_FILTER && pill.operator === 'is' && pill.value)
    ?.value;
}

/**
 * Put `vaultId` into the pills as the one "vault is …" pill, replacing any
 * other, or drop it when `vaultId` is undefined. Other pills (including a
 * half-built one the user is still choosing a value for) are left alone.
 */
export function withVaultPill<T extends FilterPill>(
  pills: readonly T[],
  vaultId: string | undefined,
  makePill: (vaultId: string) => T,
): T[] {
  const others = pills.filter(
    (pill) => !(pill.field === VAULT_FILTER && pill.operator === 'is' && pill.value),
  );
  return vaultId ? [makePill(vaultId), ...others] : others;
}

/** One group of the item list: a vault's items, with its heading. */
export interface VaultGroup {
  id: string;
  label: string;
  sortOrder: number;
  filter: (item: { vaultId: string }) => boolean;
}

/** Groups for the item list: the personal vault first, then shared vaults by name. */
export function buildVaultGroups(
  vaults: readonly WeldPassVault[],
  label: (vault: WeldPassVault) => string,
): VaultGroup[] {
  return sortVaults(vaults).map((vault, index) => ({
    id: vault.id,
    label: label(vault),
    sortOrder: index,
    filter: (item) => item.vaultId === vault.id,
  }));
}

/** Vaults matching a search box, by the name shown and the description. */
export function filterVaults(
  vaults: readonly WeldPassVault[],
  query: string,
  label: (vault: WeldPassVault) => string,
): WeldPassVault[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sortVaults(vaults).filter((vault) => {
    const haystack = `${label(vault)} ${vault.description ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
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
