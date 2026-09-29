import { useEffect } from 'react';
import { isApiError } from '@weldsuite/api-client';
import { useRouter } from '@/lib/router';

/**
 * The subset of a TanStack Query result the hook needs. `isPending` (no data
 * yet, in any fetch state) is deliberate: `isLoading` is `isPending && isFetching`,
 * so it is `false` while a query is disabled (auth/workspace not ready) or while
 * the persisted cache is still being restored on a cold load. A page that treats
 * `!isLoading && !data` as "not found" therefore bounces away before the fetch has
 * even started.
 */
interface DetailQueryState {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/** What a detail page should render. */
export type DetailPageStatus =
  /** The fetch has not finished: show a loader, never navigate. */
  | 'loading'
  /** The record is available: render it. */
  | 'ready'
  /** The record does not exist and a redirect to the list is under way. */
  | 'redirecting'
  /** The fetch failed for a reason other than "not found" (offline, 5xx, 403): stay put and show an error. */
  | 'error';

/**
 * Resolve the render state of a record-detail page and send the user back to
 * the list, from an effect, only once the record is known to be gone.
 *
 * "Gone" means the query settled and either answered 404 or succeeded without a
 * record. Any other failure keeps the user on the page so that a transient
 * error does not look like a deleted record.
 */
export function useRedirectWhenMissing(
  query: DetailQueryState,
  hasRecord: boolean,
  listPath: string,
): DetailPageStatus {
  const router = useRouter();

  let status: DetailPageStatus;
  if (hasRecord) {
    status = 'ready';
  } else if (query.isPending) {
    status = 'loading';
  } else if (query.isError && !(isApiError(query.error) && query.error.status === 404)) {
    status = 'error';
  } else {
    status = 'redirecting';
  }

  useEffect(() => {
    if (status === 'redirecting') router.replace(listPath);
  }, [status, router, listPath]);

  return status;
}
