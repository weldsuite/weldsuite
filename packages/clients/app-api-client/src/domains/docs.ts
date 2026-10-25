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
  CreateDocVersionInput,
  DocRestoreResult,
  DocSession,
  DocSnapshotLike,
  DocSnapshotResponse,
  DocSummary,
  DocVersion,
  ListDocVersionsQuery,
  ListDocsQuery,
  UpdateDocInput,
  UpdateDocVersionInput,
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

    // ---- Version history ----

    /** Saved versions, newest first. */
    versions(id: string, params: ListDocVersionsQuery = {}): Promise<ListResponse<DocVersion>> {
      return api.get(`${base}/${id}/versions${buildQueryString(params)}`);
    },
    /** Saves the document as it is now (the room's live state) under a name. */
    createVersion(id: string, input: CreateDocVersionInput): Promise<DataResponse<DocVersion>> {
      return api.post(`${base}/${id}/versions`, input);
    },
    renameVersion(id: string, versionId: string, input: UpdateDocVersionInput): Promise<DataResponse<DocVersion>> {
      return api.patch(`${base}/${id}/versions/${versionId}`, input);
    },
    /** The document as a version saved it (to preview or compare). */
    versionSnapshot<Snapshot = DocSnapshotLike>(id: string, versionId: string): Promise<DataResponse<DocSnapshotResponse<Snapshot>>> {
      return api.get(`${base}/${id}/versions/${versionId}/snapshot`);
    },
    /**
     * Replaces the document with a version. The document as it was is saved
     * first as an automatic version; everyone in the room reloads.
     */
    restoreVersion(id: string, versionId: string): Promise<DataResponse<DocRestoreResult>> {
      return api.post(`${base}/${id}/versions/${versionId}/restore`, {});
    },
  };
}
