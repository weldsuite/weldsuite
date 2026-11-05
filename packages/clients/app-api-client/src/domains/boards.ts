/**
 * App-API WeldBoard domain client: `/api/boards/*` (board-api).
 *
 * Board records, the room's live snapshot, versions, imports and the AI and
 * task actions. Content goes over the board's room socket, opened with the
 * ticket `session()` returns.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  BoardAiInput,
  BoardAiResult,
  BoardRestoreResult,
  BoardSession,
  BoardSnapshotLike,
  BoardSnapshotResponse,
  BoardSummary,
  BoardTasksInput,
  BoardTasksResult,
  BoardVersion,
  ConvertBoardInput,
  CreateBoardInput,
  CreateBoardVersionInput,
  ImportBoardInput,
  ListBoardVersionsQuery,
  ListBoardsQuery,
  ResolveBoardRecordsInput,
  ResolveBoardRecordsResult,
  UnfurlInput,
  UnfurlResult,
  UpdateBoardInput,
  UpdateBoardVersionInput,
} from '../schemas/boards';

const base = '/boards';

export function createBoardsApi(api: ClientApi) {
  return {
    list(params: ListBoardsQuery = {}): Promise<ListResponse<BoardSummary>> {
      return api.get(`${base}${buildQueryString(params)}`);
    },
    get(id: string): Promise<DataResponse<BoardSummary>> {
      return api.get(`${base}/${encodeURIComponent(id)}`);
    },
    /** Creates a board: empty, from a snapshot, or as a copy of another board. */
    create(input: CreateBoardInput = {}): Promise<DataResponse<BoardSummary>> {
      return api.post(base, input);
    },
    update(id: string, input: UpdateBoardInput): Promise<DataResponse<BoardSummary>> {
      return api.patch(`${base}/${encodeURIComponent(id)}`, input);
    },
    /** Moves the board to the WeldDrive trash. */
    remove(id: string): Promise<void> {
      return api.delete(`${base}/${encodeURIComponent(id)}`);
    },
    session(id: string): Promise<DataResponse<BoardSession>> {
      return api.post(`${base}/${encodeURIComponent(id)}/session`, {});
    },
    snapshot<Snapshot = BoardSnapshotLike>(id: string): Promise<DataResponse<BoardSnapshotResponse<Snapshot>>> {
      return api.get(`${base}/${encodeURIComponent(id)}/snapshot`);
    },
    /** An old WeldFlow whiteboard as a board (idempotent: an already converted one is returned as it is). */
    convert(input: ConvertBoardInput): Promise<DataResponse<BoardSummary>> {
      return api.post(`${base}/convert`, input);
    },
    import(input: ImportBoardInput): Promise<DataResponse<BoardSummary & { skipped: number }>> {
      return api.post(`${base}/import`, input);
    },
    unfurl(input: UnfurlInput): Promise<DataResponse<UnfurlResult>> {
      return api.post(`${base}/unfurl`, input);
    },
    ai(id: string, input: BoardAiInput): Promise<DataResponse<BoardAiResult>> {
      return api.post(`${base}/${encodeURIComponent(id)}/ai`, input);
    },
    /** What record cards show, for the records the caller may see. */
    records(input: ResolveBoardRecordsInput): Promise<DataResponse<ResolveBoardRecordsResult>> {
      return api.post(`${base}/records`, input);
    },
    tasks(id: string, input: BoardTasksInput): Promise<DataResponse<BoardTasksResult>> {
      return api.post(`${base}/${encodeURIComponent(id)}/tasks`, input);
    },

    // ---- Version history ----

    versions(id: string, params: ListBoardVersionsQuery = {}): Promise<ListResponse<BoardVersion>> {
      return api.get(`${base}/${encodeURIComponent(id)}/versions${buildQueryString(params)}`);
    },
    createVersion(id: string, input: CreateBoardVersionInput): Promise<DataResponse<BoardVersion>> {
      return api.post(`${base}/${encodeURIComponent(id)}/versions`, input);
    },
    renameVersion(id: string, versionId: string, input: UpdateBoardVersionInput): Promise<DataResponse<BoardVersion>> {
      return api.patch(`${base}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`, input);
    },
    versionSnapshot<Snapshot = BoardSnapshotLike>(id: string, versionId: string): Promise<DataResponse<BoardSnapshotResponse<Snapshot>>> {
      return api.get(`${base}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/snapshot`);
    },
    restoreVersion(id: string, versionId: string): Promise<DataResponse<BoardRestoreResult>> {
      return api.post(`${base}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, {});
    },
  };
}
