/**
 * The `form_responses` connected table: a form's completed responses, listed
 * by @weldsuite/forms-domain with the connector's access (`form_responses:read`
 * is checked by the caller, the form's own visibility here). Not a catalog
 * table of this worker, because each form has its own columns.
 */

import type { Database } from '@weldsuite/worker-kit/db';
import type { SheetDataDefinition } from '@weldsuite/app-api-client/schemas/sheet-data';
import {
  FormColumnError,
  FormNotVisibleError,
  listFormColumns,
  listResponsesForSheet,
  type FormsViewer,
} from '@weldsuite/forms-domain/sheet';
import type { DataViewer } from './catalog';
import { SheetDataPermissionError } from './errors';
import type { DataCell } from './query';


const FORM_PERMISSION = 'form_responses:read';

function formsViewer(viewer: DataViewer): FormsViewer {
  return { userId: viewer.userId, hasPermission: viewer.hasPermission };
}

/** A form the viewer cannot see lists as no access, never as an empty table. */
function translate(err: unknown): never {
  if (err instanceof FormNotVisibleError) throw new SheetDataPermissionError(FORM_PERMISSION);
  if (err instanceof FormColumnError) throw new Error(err.message);
  throw err;
}

export async function listFormResponses(db: Database, def: SheetDataDefinition, viewer: DataViewer): Promise<DataCell[][]> {
  if (!def.formId) throw new Error('Pick the form whose responses to list');
  try {
    return await listResponsesForSheet(db, def.formId, def, formsViewer(viewer));
  } catch (err) {
    return translate(err);
  }
}

/** The type of each column of the form, by key, for the sheet's number formats. */
export async function formColumnTypes(db: Database, formId: string, viewer: DataViewer): Promise<Map<string, string>> {
  try {
    return new Map((await listFormColumns(db, formId, formsViewer(viewer))).map((c) => [c.key, c.type]));
  } catch (err) {
    return translate(err);
  }
}
