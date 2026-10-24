import type { createSheetsApi } from '@weldsuite/app-api-client/domains/sheets';
import type { SheetSummary } from '@weldsuite/app-api-client/schemas/sheets';
import type { SheetDirectory, SheetMeta } from './sheet-store';

type SheetsApi = ReturnType<typeof createSheetsApi>;

/** The home page shows recent sheets; older ones are found in WeldDrive. */
const LIST_LIMIT = 100;

/** Spreadsheets in sheets-api (each one a WeldDrive file). */
export class ApiSheetDirectory implements SheetDirectory {
  constructor(private readonly api: SheetsApi) {}

  async list(): Promise<SheetMeta[]> {
    const { data } = await this.api.list({ limit: LIST_LIMIT });
    return data.map(toMeta);
  }

  async create(name: string, firstTabName: string): Promise<SheetMeta> {
    const { data } = await this.api.create({ name, firstTabName });
    return toMeta(data);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.api.update(id, { name });
  }

  async remove(id: string): Promise<void> {
    await this.api.remove(id);
  }
}

export function toMeta(sheet: SheetSummary): SheetMeta {
  return {
    id: sheet.id,
    name: sheet.name,
    createdAt: Date.parse(sheet.createdAt),
    updatedAt: Date.parse(sheet.updatedAt),
    canEdit: sheet.canEdit,
  };
}
