/**
 * App-API WeldSheets domain client — `/api/sheets/*` (sheets-api).
 *
 * Spreadsheet records, files in and out (import, export), version history,
 * connected tables of WeldSuite data, and old WeldFlow project sheets
 * converted on first open. Content goes over the sheet's room socket, opened
 * with the ticket `session()` returns.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  ConvertProjectSheetInput,
  CreateSheetDataSourceInput,
  CreateSheetInput,
  CreateSheetVersionInput,
  ExportSheetQuery,
  ImportDriveFileInput,
  ListSheetVersionsQuery,
  ListSheetsQuery,
  SheetDataRefreshResult,
  SheetDataSource,
  SheetFileLocale,
  SheetImportResult,
  SheetSession,
  SheetRestoreResult,
  SheetSummary,
  SheetVersion,
  SheetVersionSnapshot,
  UpdateSheetDataSourceInput,
  UpdateSheetInput,
  UpdateSheetVersionInput,
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
    /** An old WeldFlow project sheet (.xlsx) made a spreadsheet in place; the sheet it is now. */
    convertProjectSheet(input: ConvertProjectSheetInput): Promise<DataResponse<SheetSummary>> {
      return api.post(`${base}/convert`, input);
    },

    // ---- Version history ----

    /** Saved versions, newest first. */
    versions(id: string, params: ListSheetVersionsQuery = {}): Promise<ListResponse<SheetVersion>> {
      return api.get(`${base}/${id}/versions${buildQueryString(params)}`);
    },
    /** Saves the spreadsheet as it is now under a name. */
    createVersion(id: string, input: CreateSheetVersionInput): Promise<DataResponse<SheetVersion>> {
      return api.post(`${base}/${id}/versions`, input);
    },
    renameVersion(id: string, versionId: string, input: UpdateSheetVersionInput): Promise<DataResponse<SheetVersion>> {
      return api.patch(`${base}/${id}/versions/${versionId}`, input);
    },
    /** The workbook as the version saved it (a WorkbookSnapshot). */
    versionSnapshot(id: string, versionId: string): Promise<DataResponse<SheetVersionSnapshot>> {
      return api.get(`${base}/${id}/versions/${versionId}/snapshot`);
    },
    /** Makes the version the spreadsheet again; the sheet as it was is kept as an automatic version. */
    restoreVersion(id: string, versionId: string): Promise<DataResponse<SheetRestoreResult>> {
      return api.post(`${base}/${id}/versions/${versionId}/restore`, {});
    },

    // ---- Connected tables ----

    dataSources(id: string): Promise<ListResponse<SheetDataSource>> {
      return api.get(`${base}/${id}/data-sources`);
    },
    /** Connects a table of WeldSuite data, written at `target` by its first refresh. */
    createDataSource(id: string, input: CreateSheetDataSourceInput): Promise<DataResponse<SheetDataRefreshResult>> {
      return api.post(`${base}/${id}/data-sources`, input);
    },
    updateDataSource(id: string, sourceId: string, input: UpdateSheetDataSourceInput): Promise<DataResponse<SheetDataRefreshResult>> {
      return api.patch(`${base}/${id}/data-sources/${sourceId}`, input);
    },
    refreshDataSource(id: string, sourceId: string): Promise<DataResponse<SheetDataRefreshResult>> {
      return api.post(`${base}/${id}/data-sources/${sourceId}/refresh`, {});
    },
    /** Disconnects a table; its values stay in the sheet. */
    removeDataSource(id: string, sourceId: string): Promise<void> {
      return api.delete(`${base}/${id}/data-sources/${sourceId}`);
    },
  };
}
