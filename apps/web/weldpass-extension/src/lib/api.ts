import { createClientApi } from '@weldsuite/api-client';
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

export function createPasswordsApi(options: {
  /** app-api origin; the client appends `/api`. */
  apiUrl: string;
  /** A fresh Clerk session JWT. The workspace is the token's active organization. */
  getToken: () => Promise<string | null>;
}): WeldPassPasswordsApi {
  return createWeldPassPasswordsApi(
    createClientApi({
      baseUrl: options.apiUrl,
      getToken: options.getToken,
      getExtraHeaders: () => ({ ...CLIENT_HEADERS }),
    }),
  );
}
