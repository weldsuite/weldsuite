/**
 * App-API WeldSheets domain client — `/api/sheets/*` (sheets-api).
 *
 * Spreadsheet records only. Content goes over the sheet's room socket, opened
 * with the ticket `session()` returns.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type { CreateSheetInput, ListSheetsQuery, SheetSession, SheetSummary, UpdateSheetInput } from '../schemas/sheets';

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
  };
}
