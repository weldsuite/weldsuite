/**
 * The passwords API as the popup sees it: every call goes to the service
 * worker, which holds the token and the workspace (ADR PASS-009). The shapes
 * are the typed client's, so the popup's views and actions are unchanged.
 */

import type {
  WeldPassHealthReport,
  WeldPassItem,
  WeldPassItemInput,
  WeldPassItemVersion,
  WeldPassRevealedItem,
  WeldPassTotpCode,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { request } from '../lib/messaging';
import type { PageResponses } from '../lib/protocol';

export interface PopupApi {
  matchItems(url: string): Promise<{ data: WeldPassItem[] }>;
  listItems(params?: { type?: 'login' }): Promise<{ data: WeldPassItem[] }>;
  listVaults(): Promise<{ data: WeldPassVault[] }>;
  revealItem(vaultId: string, itemId: string): Promise<{ data: WeldPassRevealedItem }>;
  generateTotp(vaultId: string, itemId: string): Promise<{ data: WeldPassTotpCode }>;
  createItem(vaultId: string, input: WeldPassItemInput): Promise<{ data: WeldPassItem }>;
  passwordHealth(): Promise<{ data: WeldPassHealthReport }>;
  itemVersions(vaultId: string, itemId: string): Promise<{ data: WeldPassItemVersion[] }>;
  notifications(): Promise<{ data: PageResponses['notifications:list'] }>;
  markNotificationRead(id: string): Promise<unknown>;
  markAllNotificationsRead(): Promise<unknown>;
}

export const popupApi: PopupApi = {
  matchItems: async (url) => ({ data: await request({ type: 'items:match', url }) }),
  listItems: async () => ({ data: await request({ type: 'items:list' }) }),
  listVaults: async () => ({ data: await request({ type: 'vaults:list' }) }),
  revealItem: async (vaultId, itemId) => ({ data: await request({ type: 'item:reveal', vaultId, itemId }) }),
  generateTotp: async (vaultId, itemId) => ({ data: await request({ type: 'item:totp', vaultId, itemId }) }),
  createItem: async (vaultId, input) => ({ data: await request({ type: 'item:create', vaultId, input }) }),
  passwordHealth: async () => ({ data: await request({ type: 'health:get' }) }),
  itemVersions: async (vaultId, itemId) => ({ data: await request({ type: 'item:versions', vaultId, itemId }) }),
  notifications: async () => ({ data: await request({ type: 'notifications:list' }) }),
  markNotificationRead: (id) => request({ type: 'notifications:read', id }),
  markAllNotificationsRead: () => request({ type: 'notifications:read-all' }),
};
