/**
 * The caller as an agent viewer: who they are and whether they manage every
 * agent (`weldagent:manage`). See @weldsuite/agent-domain/access.
 */

import { ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { agentViewerFor, type AgentViewer } from '@weldsuite/agent-domain/access';

export async function agentViewer(c: Parameters<typeof ensurePermissionsResolved>[0]): Promise<AgentViewer> {
  return agentViewerFor(c.get('userId') as string, await ensurePermissionsResolved(c));
}
