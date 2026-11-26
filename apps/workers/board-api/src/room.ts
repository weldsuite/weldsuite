/**
 * BoardRoom as board-api runs it: the room from @weldsuite/board-domain, on the
 * workspace's Neon database through worker-kit. collab-rooms runs the same
 * room on Node with its own database (apps/tools/collab-rooms).
 */

import { BoardRoom as Room } from '@weldsuite/board-domain/room/board-room';
import type { Env } from '@weldsuite/board-domain/types';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';

export class BoardRoom extends Room<Env> {
  protected tenantDb(workspaceId: string) {
    return getTenantDbForWorkspace(this.env, workspaceId);
  }
}
