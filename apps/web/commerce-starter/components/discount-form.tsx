'use client';

import { useActionState, useId } from 'react';

import { applyDiscountAction } from '@/lib/actions/cart';
import { idle } from '@/lib/actions/state';

import { FormMessage, PendingButton, submitKeepingValues } from './form-bits';

export function DiscountForm() {
  const [state, action, pending] = useActionState(applyDiscountAction, idle);
  const id = useId();
  const error = state.fieldErrors?.code;
  return (
    <form action={action} onSubmit={submitKeepingValues(action)} className="flex flex-col gap-2">
      <label htmlFor={id} className="label">
        Discount code
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={100}
          aria-invalid={error ? true : undefined}
          className="min-w-0 flex-1"
        />
        <PendingButton pending={pending} className="btn btn-secondary" pendingText="Applying…">
          Apply
        </PendingButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
