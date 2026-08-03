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

export function useDeleteDomain() {
  const { domains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => domains.delete(id),
    onSuccess: () => {
      // Mirrors `hostKeys` in use-host-queries. `['host','domains']` is a
      // prefix of the per-domain key too, so this covers the deleted row,
      // every list page and its DNS sub-queries in one go.
      qc.invalidateQueries({ queryKey: ['host', 'domains'] });
      qc.invalidateQueries({ queryKey: ['host', 'dashboard'] });
    },
  });
}
