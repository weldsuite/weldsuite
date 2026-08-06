/**
 * Domain panel data hooks.
 *
 * The read + DNS mutation hooks already live in `use-host-queries` (shared
 * with the full-page `/weldhost/domains/[id]` route), so this module only
 * adds what the panel needs on top of them — currently the delete mutation,
 * which the legacy panel delegated back to its caller.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { hostKeys } from '@/hooks/queries/use-host-queries';

export function useDeleteDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => domains.delete(id),
    onSuccess: () => {
      // Reuse the key factory rather than literal arrays, so a prefix change
      // in use-host-queries can't silently stop these from matching.
      // `hostKeys.domains()` is a prefix of the per-domain key too, so this
      // covers the deleted row, every list page and its DNS sub-queries.
      qc.invalidateQueries({ queryKey: hostKeys.domains() });
      qc.invalidateQueries({ queryKey: hostKeys.dashboard() });
    },
  });
}
