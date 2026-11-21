/**
 * Audit log streams domain client: `/api/audit-log-streams` (app-api, core).
 *
 * Destinations a workspace's audit events are pushed to (Splunk HEC or an
 * HTTPS collector). Every route needs `general:update`. The token is
 * write-only: rows carry `hasToken`, never the token.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import type {
  AuditLogStream,
  AuditLogStreamTestResult,
  CreateAuditLogStreamInput,
  UpdateAuditLogStreamInput,
} from '../schemas/audit-log-streams';

export function createAuditLogStreamsApi(api: ClientApi) {
  const base = '/audit-log-streams';
  const enc = encodeURIComponent;

  return {
    /** Oldest first; a workspace has at most five. */
    list(): Promise<ListResponse<AuditLogStream>> {
      return api.get<ListResponse<AuditLogStream>>(base);
    },
    create(input: CreateAuditLogStreamInput): Promise<DataResponse<AuditLogStream>> {
      return api.post<DataResponse<AuditLogStream>>(base, input);
    },
    update(id: string, input: UpdateAuditLogStreamInput): Promise<DataResponse<AuditLogStream>> {
      return api.patch<DataResponse<AuditLogStream>>(`${base}/${enc(id)}`, input);
    },
    delete(id: string): Promise<void> {
      return api.delete<void>(`${base}/${enc(id)}`);
    },
    /** One synthetic event to the destination. A refused destination is still HTTP 200 with `ok: false`. */
    test(id: string): Promise<DataResponse<AuditLogStreamTestResult>> {
      return api.post<DataResponse<AuditLogStreamTestResult>>(`${base}/${enc(id)}/test`, {});
    },
  };
}
