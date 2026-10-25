import type { createDocsApi } from '@weldsuite/app-api-client/domains/docs';
import type { DocSummary } from '@weldsuite/app-api-client/schemas/docs';
import type { DocSnapshot } from '@weldsuite/docs-engine';
import type { DocDirectory, DocMeta } from './doc-store';

type DocsApi = ReturnType<typeof createDocsApi>;

/** The home page shows recent documents; older ones are found in WeldDrive. */
const LIST_LIMIT = 100;

/** Documents in docs-api (each one a WeldDrive file). */
export class ApiDocDirectory implements DocDirectory {
  constructor(private readonly api: DocsApi) {}

  async list(): Promise<DocMeta[]> {
    const { data } = await this.api.list({ limit: LIST_LIMIT });
    return data.map(toMeta);
  }

  async create(name: string, snapshot?: DocSnapshot): Promise<DocMeta> {
    const { data } = await this.api.create(snapshot ? { name, snapshot } : { name });
    return toMeta(data);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.api.update(id, { name });
  }

  async remove(id: string): Promise<void> {
    await this.api.remove(id);
  }
}

export function toMeta(doc: DocSummary): DocMeta {
  return {
    id: doc.id,
    name: doc.name,
    createdAt: Date.parse(doc.createdAt),
    updatedAt: Date.parse(doc.updatedAt),
    canEdit: doc.canEdit,
  };
}
