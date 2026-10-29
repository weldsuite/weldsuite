/**
 * What the default WeldAgent may read for the caller: the permission keys its
 * tools need that the caller holds, checked deny-aware like any route, never
 * an agent's grants. See @weldsuite/agent-domain/persona.
 */

import { hasContextPermission } from '@weldsuite/permissions/server';
import { personaPermissionKeys } from '@weldsuite/agent-domain/persona';

export async function personaPermissions(c: Parameters<typeof hasContextPermission>[0]): Promise<string[]> {
  const keys = personaPermissionKeys();
  const held = await Promise.all(keys.map((key) => hasContextPermission(c, key)));
  return keys.filter((_, i) => held[i]);
}
