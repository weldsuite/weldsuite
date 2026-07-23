/**
 * App-API "me" domain client — self-scoped reads about the authenticated user.
 *
 * `permissions()` returns the caller's effective permissions for the active
 * workspace so first-party clients can gate UI client-side. The server still
 * enforces every mutation, so this is UX-only.
 */

import type { ClientApi, DataResponse } from '../types';

export interface MyPermissions {
  permissions: string[];
  role: string;
  roleId: string | null;
  isOwner: boolean;
}

export function createMeApi(api: ClientApi) {
  return {
    permissions(): Promise<DataResponse<MyPermissions>> {
      return api.get<DataResponse<MyPermissions>>('/me/permissions');
    },
  };
}
