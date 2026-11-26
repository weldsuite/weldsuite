import { createClientApi } from '@weldsuite/api-client';
import { createNotificationsApi } from '@weldsuite/app-api-client/domains/notifications';
import {
  createWeldPassPasswordsApi,
  type WeldPassPasswordsApi,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';

/**
 * Sent with every request. The API records it with each reveal in the vault's
 * audit trail, so a manager can tell the extension filling a form from a person
 * reading a password in the web app.
 */
export const CLIENT_HEADERS = { 'X-WeldPass-Client': 'extension' } as const;

/** Membership mode (WeldID): the token names no workspace, every request does. */
export const WORKSPACE_HEADER = 'X-Weld-Workspace';

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;

/**
 * What the worker calls: the passwords API, and the person's notifications
 * (the popup's bell) on the same connection, token and workspace.
 */
export type ExtensionApi = WeldPassPasswordsApi & { notifications: NotificationsApi };

/** The API as the service worker calls it. Only the worker holds a token. */
export function createPasswordsApi(options: {
  /** The server's API origin; the client appends `/api`. */
  apiOrigin: string;
  getToken: () => Promise<string | null>;
  /** `header` mode: the chosen workspace (`workspaces.id`). `null` in claim mode. */
  getWorkspaceId: () => string | null;
}): ExtensionApi {
  const client = createClientApi({
    baseUrl: options.apiOrigin,
    getToken: options.getToken,
    getExtraHeaders: () => {
      const workspaceId = options.getWorkspaceId();
      return workspaceId ? { ...CLIENT_HEADERS, [WORKSPACE_HEADER]: workspaceId } : { ...CLIENT_HEADERS };
    },
  });
  return Object.assign(createWeldPassPasswordsApi(client), { notifications: createNotificationsApi(client) });
}
