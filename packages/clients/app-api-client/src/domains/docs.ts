/**
 * App-API WeldDocs domain client: `/api/docs/*` (docs-api).
 *
 * Document records, and the room's live snapshot. Content goes over the
 * document's room socket, opened with the ticket `session()` returns.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateDocInput,
  DocSession,
  DocSnapshotLike,
  DocSnapshotResponse,
  DocSummary,
  ListDocsQuery,
  UpdateDocInput,
} from '../schemas/docs';

const base = '/docs';

export function createDocsApi(api: ClientApi) {
  return {
    list(params: ListDocsQuery = {}): Promise<ListResponse<DocSummary>> {
      return api.get(`${base}${buildQueryString(params)}`);
    },
    get(id: string): Promise<DataResponse<DocSummary>> {
      return api.get(`${base}/${id}`);
    },
    /** Creates a document, empty or from `snapshot` (an imported file). */
    create(input: CreateDocInput = {}): Promise<DataResponse<DocSummary>> {
      return api.post(base, input);
    },
    /** Renames and/or moves a document. */
    update(id: string, input: UpdateDocInput): Promise<DataResponse<DocSummary>> {
      return api.patch(`${base}/${id}`, input);
    },
    /** Moves the document to the WeldDrive trash. */
    remove(id: string): Promise<void> {
      return api.delete(`${base}/${id}`);
    },
    session(id: string): Promise<DataResponse<DocSession>> {
      return api.post(`${base}/${id}/session`, {});
    },
    /** The document as the room holds it now (for downloads, printing and exports of a read-only document). */
    snapshot<Snapshot = DocSnapshotLike>(id: string): Promise<DataResponse<DocSnapshotResponse<Snapshot>>> {
      return api.get(`${base}/${id}/snapshot`);
    },
  };
}
