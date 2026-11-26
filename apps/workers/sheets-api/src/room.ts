/**
 * SheetRoom as sheets-api runs it: the room from @weldsuite/sheets-domain, on the
 * workspace's Neon database through worker-kit. collab-rooms runs the same
 * room on Node with its own database (apps/tools/collab-rooms).
 */

import { SheetRoom as Room } from '@weldsuite/sheets-domain/room/sheet-room';
import type { Env } from '@weldsuite/sheets-domain/types';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';

export class SheetRoom extends Room<Env> {
  protected tenantDb(workspaceId: string) {
    return getTenantDbForWorkspace(this.env, workspaceId);
  }
}
