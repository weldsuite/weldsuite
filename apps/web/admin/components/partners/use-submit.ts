'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { keepsRequestId, newRequestId } from '@/lib/billing-format';
import type { ActionResult } from '@/actions/workspaces';

export type Failure = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * Submit state for the partner forms that have no reason box (those use
 * ActionDialog). One request id per submission is the worker's idempotency
 * key: kept after an ambiguous failure so a retry replays, renewed otherwise.
 */
export function useSubmit() {
  const [requestId, setRequestId] = useState(newRequestId);
  const [isPending, startTransition] = useTransition();

  function submit<T>(
    run: (requestId: string) => Promise<ActionResult<T>>,
    options: {
      success: string | ((data: T) => string);
      onSuccess?: (data: T) => void;
      /** Return true when the failure was shown by the caller (skips the toast). */
      onFailure?: (failure: Failure) => boolean | void;
    },
  ) {
    startTransition(async () => {
      const result = await run(requestId);
      if (!result.ok) {
        if (!keepsRequestId(result.code)) setRequestId(newRequestId());
        if (options.onFailure?.(result) !== true) toast.error(result.error);
        return;
      }
      setRequestId(newRequestId());
      toast.success(typeof options.success === 'function' ? options.success(result.data) : options.success);
      options.onSuccess?.(result.data);
    });
  }

  return { submit, isPending };
}
