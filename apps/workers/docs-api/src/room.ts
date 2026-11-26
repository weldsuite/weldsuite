/**
 * DocRoom as docs-api runs it: the room from @weldsuite/docs-domain, on the
 * workspace's Neon database through worker-kit. collab-rooms runs the same
 * room on Node with its own database (apps/tools/collab-rooms).
 */

import { DocRoom as Room } from '@weldsuite/docs-domain/room/doc-room';
import type { Env } from '@weldsuite/docs-domain/types';
import { getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';

export class DocRoom extends Room<Env> {
  protected tenantDb(workspaceId: string) {
    return getTenantDbForWorkspace(this.env, workspaceId);
  }
}
