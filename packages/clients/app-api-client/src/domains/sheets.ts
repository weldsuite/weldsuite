/**
 * App-API WeldSheets domain client — `/api/sheets/*` (sheets-api).
 *
 * Spreadsheet records, and files in and out (import, export). Content goes
 * over the sheet's room socket, opened with the ticket `session()` returns.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateSheetInput,
  ExportSheetQuery,
  ImportDriveFileInput,
  ListSheetsQuery,
  SheetFileLocale,
  SheetImportResult,
  SheetSession,
  SheetSummary,
  UpdateSheetInput,
} from '../schemas/sheets';

const base = '/sheets';

export function createSheetsApi(api: ClientApi) {
  return {
    list(params: ListSheetsQuery = {}): Promise<ListResponse<SheetSummary>> {
      return api.get(`${base}${buildQueryString(params)}`);
    },
    get(id: string): Promise<DataResponse<SheetSummary>> {
      return api.get(`${base}/${id}`);
    },
    create(input: CreateSheetInput): Promise<DataResponse<SheetSummary>> {
      return api.post(base, input);
    },
    update(id: string, input: UpdateSheetInput): Promise<DataResponse<SheetSummary>> {
      return api.patch(`${base}/${id}`, input);
    },
    /** Moves the sheet to the WeldDrive trash. */
    remove(id: string): Promise<void> {
      return api.delete(`${base}/${id}`);
    },
    session(id: string): Promise<DataResponse<SheetSession>> {
      return api.post(`${base}/${id}/session`, {});
    },
    /** Uploads an .xlsx, .csv or .tsv file as a new spreadsheet. */
    importFile(
      file: File,
      options: { name?: string; folderId?: string | null; locale?: SheetFileLocale } = {},
    ): Promise<DataResponse<SheetImportResult>> {
      const form = new FormData();
      form.append('file', file);
      if (options.name) form.append('name', options.name);
      if (options.folderId) form.append('folderId', options.folderId);
      if (options.locale) form.append('locale', options.locale);
      return api.postForm(`${base}/import`, form);
    },
    /** Makes a new spreadsheet from an .xlsx, .csv or .tsv file in WeldDrive (the file stays). */
    importDriveFile(input: ImportDriveFileInput): Promise<DataResponse<SheetImportResult>> {
      return api.post(`${base}/import`, input);
    },
    /** The spreadsheet as an .xlsx or .csv file; read the response as a blob. */
    exportFile(id: string, query: ExportSheetQuery = {}): Promise<Response> {
      return api.getRaw(`${base}/${id}/export${buildQueryString(query)}`);
    },
  };
}
