/** WeldHR departments as a tree (`parentId` links). */

import type { HrDepartment } from '@weldsuite/app-api-client/domains/weldhr';

/** The department and every department below it, following `parentId` (stops on a loop already in the data). */
export function subtreeOf(departments: ReadonlyArray<Pick<HrDepartment, 'id' | 'parentId'>>, rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const dept of departments) {
      if (dept.parentId && out.has(dept.parentId) && !out.has(dept.id)) {
        out.add(dept.id);
        grew = true;
      }
    }
  }
  return out;
}
