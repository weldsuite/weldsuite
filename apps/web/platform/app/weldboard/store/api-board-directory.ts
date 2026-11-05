import type { createBoardsApi } from '@weldsuite/app-api-client/domains/boards';
import type { BoardSummary } from '@weldsuite/app-api-client/schemas/boards';
import type { BoardSnapshot } from '@weldsuite/board-engine';
import type { BoardDirectory, BoardMeta } from './board-store';

type BoardsApi = ReturnType<typeof createBoardsApi>;

/** The home page shows recent boards; older ones are found in WeldDrive. */
const LIST_LIMIT = 100;

/** Boards in board-api (each one a WeldDrive file). */
export class ApiBoardDirectory implements BoardDirectory {
  constructor(private readonly api: BoardsApi) {}

  async list(options: { projectId?: string; templates?: boolean; projects?: boolean } = {}): Promise<BoardMeta[]> {
    const { data } = await this.api.list({
      limit: LIST_LIMIT,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.templates ? { templates: 'true' as const } : {}),
      ...(options.projects ? { projects: 'true' as const } : {}),
    });
    return data.map(toMeta);
  }

  async create(name: string, options: { snapshot?: BoardSnapshot; projectId?: string; fromBoardId?: string } = {}): Promise<BoardMeta> {
    const { data } = await this.api.create({
      name,
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.fromBoardId ? { fromBoardId: options.fromBoardId } : {}),
    });
    return toMeta(data);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.api.update(id, { name });
  }

  async remove(id: string): Promise<void> {
    await this.api.remove(id);
  }
}

export function toMeta(board: BoardSummary): BoardMeta {
  return {
    id: board.id,
    name: board.name,
    createdAt: Date.parse(board.createdAt),
    updatedAt: Date.parse(board.updatedAt),
    canEdit: board.canEdit,
    projectId: board.projectId,
    templateCategory: board.templateCategory,
    legacy: board.legacy,
    fileId: board.fileId,
  };
}
