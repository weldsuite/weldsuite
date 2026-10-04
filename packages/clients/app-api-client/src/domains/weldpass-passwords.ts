/**
 * App-API WeldPass password manager client — `/api/weldpass/{vaults,items}`.
 *
 * A password only ever travels on `revealItem`. Lists return titles, the
 * username line and the site, so a list view can render — and the browser
 * extension can match a page — without a secret reaching the client.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  WeldPassImportFormat,
  WeldPassItemFields,
  WeldPassItemInput,
  WeldPassItemType,
  WeldPassVaultRole,
} from '../schemas/weldpass-passwords';

export type {
  WeldPassCardFields,
  WeldPassImportFormat,
  WeldPassItemFields,
  WeldPassItemInput,
  WeldPassItemType,
  WeldPassLoginFields,
  WeldPassNoteFields,
  WeldPassVaultRole,
} from '../schemas/weldpass-passwords';

export interface WeldPassVault {
  id: string;
  kind: 'personal' | 'shared';
  ownerId: string | null;
  name: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The caller's role. Null for a workspace admin looking at a shared vault
   * they are not a member of: they can manage its members, not read its items.
   */
  role: WeldPassVaultRole | null;
  /** Present on the vault list. */
  itemCount?: number;
  memberCount?: number;
}

export interface WeldPassVaultMember {
  userId: string;
  role: WeldPassVaultRole;
  name: string | null;
  email: string | null;
  picture: string | null;
  addedBy: string | null;
  createdAt: string;
}

export interface WeldPassTeammate {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

/** What a list shows. Nothing here is secret. */
export interface WeldPassItem {
  id: string;
  vaultId: string;
  type: WeldPassItemType;
  title: string;
  /** Login username, or "•••• 4242" for a card. */
  subtitle: string | null;
  url: string | null;
  host: string | null;
  hasTotp: boolean;
  passwordChangedAt: string | null;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeldPassRevealedItem extends WeldPassItem {
  fields: WeldPassItemFields;
}

export interface WeldPassItemVersion {
  id: string;
  version: number;
  action: string;
  createdBy: string | null;
  createdAt: string;
}

export interface WeldPassTotpCode {
  code: string;
  period: number;
  expiresAt: string;
}

export interface WeldPassImportNote {
  line: number;
  reason: string;
}

export interface WeldPassItemImportResult {
  format: string;
  created: number;
  skipped: WeldPassImportNote[];
  warnings: WeldPassImportNote[];
}

export type WeldPassPasswordIssue = 'weak' | 'reused' | 'old';

export interface WeldPassHealthEntry extends WeldPassItem {
  issues: WeldPassPasswordIssue[];
  /** How many of the caller's logins share this password, itself included. */
  reuseCount: number;
}

export interface WeldPassHealthReport {
  /** Logins that have a password at all. */
  checked: number;
  healthy: number;
  weak: number;
  reused: number;
  old: number;
  /** Only the logins with something to fix, worst first. */
  items: WeldPassHealthEntry[];
}

export interface WeldPassVaultEvent {
  id: string;
  itemId: string | null;
  actorId: string;
  actorName: string | null;
  action: string;
  targetLabel: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const base = '/weldpass';

function itemPath(vaultId: string, itemId: string) {
  return `${base}/vaults/${vaultId}/items/${itemId}`;
}

export function createWeldPassPasswordsApi(api: ClientApi) {
  return {
    // Vaults ---------------------------------------------------------------
    /** Creates the caller's personal vault on first call. */
    listVaults(): Promise<DataResponse<WeldPassVault[]>> {
      return api.get(`${base}/vaults`);
    },

    createVault(body: {
      name: string;
      description?: string | null;
    }): Promise<DataResponse<WeldPassVault>> {
      return api.post(`${base}/vaults`, body);
    },

    updateVault(
      vaultId: string,
      body: { name?: string; description?: string | null },
    ): Promise<DataResponse<WeldPassVault>> {
      return api.patch(`${base}/vaults/${vaultId}`, body);
    },

    deleteVault(vaultId: string): Promise<void> {
      return api.delete(`${base}/vaults/${vaultId}`);
    },

    // Members --------------------------------------------------------------
    listTeammates(): Promise<DataResponse<WeldPassTeammate[]>> {
      return api.get(`${base}/teammates`);
    },

    listMembers(vaultId: string): Promise<DataResponse<WeldPassVaultMember[]>> {
      return api.get(`${base}/vaults/${vaultId}/members`);
    },

    /** Adds a teammate, or changes their role if they are already a member. */
    addMember(
      vaultId: string,
      body: { userId: string; role: WeldPassVaultRole },
    ): Promise<DataResponse<WeldPassVaultMember[]>> {
      return api.post(`${base}/vaults/${vaultId}/members`, body);
    },

    updateMember(
      vaultId: string,
      userId: string,
      role: WeldPassVaultRole,
    ): Promise<DataResponse<WeldPassVaultMember[]>> {
      return api.patch(`${base}/vaults/${vaultId}/members/${userId}`, { role });
    },

    /** Remove a member — or leave, when `userId` is the caller. */
    removeMember(vaultId: string, userId: string): Promise<void> {
      return api.delete(`${base}/vaults/${vaultId}/members/${userId}`);
    },

    /** Requires the manager role on the vault. */
    listActivity(
      vaultId: string,
      params: { limit?: number; cursor?: string } = {},
    ): Promise<ListResponse<WeldPassVaultEvent>> {
      return api.get(
        `${base}/vaults/${vaultId}/activity${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    // Items ----------------------------------------------------------------
    /** Every item the caller can open, or one vault's. */
    listItems(
      params: { vaultId?: string; type?: WeldPassItemType } = {},
    ): Promise<DataResponse<WeldPassItem[]>> {
      return api.get(`${base}/items${buildQueryString(params as Record<string, unknown>)}`);
    },

    /** Logins saved for the site at `url`. */
    matchItems(url: string): Promise<DataResponse<WeldPassItem[]>> {
      return api.get(`${base}/items/match${buildQueryString({ url })}`);
    },

    createItem(vaultId: string, body: WeldPassItemInput): Promise<DataResponse<WeldPassItem>> {
      return api.post(`${base}/vaults/${vaultId}/items`, body);
    },

    /** Replaces the whole item — send every field, not only the changed ones. */
    updateItem(
      vaultId: string,
      itemId: string,
      body: WeldPassItemInput,
    ): Promise<DataResponse<WeldPassItem>> {
      return api.put(itemPath(vaultId, itemId), body);
    },

    deleteItem(vaultId: string, itemId: string): Promise<void> {
      return api.delete(itemPath(vaultId, itemId));
    },

    /** Decrypts the item. Every call is written to the vault's trail. */
    revealItem(vaultId: string, itemId: string): Promise<DataResponse<WeldPassRevealedItem>> {
      return api.get(`${itemPath(vaultId, itemId)}/reveal`);
    },

    /** The current 2FA code; the seed stays on the server. */
    generateTotp(vaultId: string, itemId: string): Promise<DataResponse<WeldPassTotpCode>> {
      return api.post(`${itemPath(vaultId, itemId)}/totp`, {});
    },

    /** Moves the item into another vault. Returns the new item — its id changes. */
    moveItem(
      vaultId: string,
      itemId: string,
      targetVaultId: string,
    ): Promise<DataResponse<WeldPassItem>> {
      return api.post(`${itemPath(vaultId, itemId)}/move`, { targetVaultId });
    },

    listItemVersions(
      vaultId: string,
      itemId: string,
    ): Promise<DataResponse<WeldPassItemVersion[]>> {
      return api.get(`${itemPath(vaultId, itemId)}/versions`);
    },

    restoreItemVersion(
      vaultId: string,
      itemId: string,
      version: number,
    ): Promise<DataResponse<WeldPassItem>> {
      return api.post(`${itemPath(vaultId, itemId)}/restore`, { version });
    },

    importItems(
      vaultId: string,
      body: { content: string; format?: WeldPassImportFormat },
    ): Promise<DataResponse<WeldPassItemImportResult>> {
      return api.post(`${base}/vaults/${vaultId}/items/import`, body);
    },

    // Health ---------------------------------------------------------------
    passwordHealth(): Promise<DataResponse<WeldPassHealthReport>> {
      return api.get(`${base}/password-health`);
    },
  };
}

export type WeldPassPasswordsApi = ReturnType<typeof createWeldPassPasswordsApi>;
