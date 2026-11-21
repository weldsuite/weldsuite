'use client';

import { useActionState, useEffect, useId, useRef } from 'react';

import { signInAction, type SignInState } from '@/lib/actions/account';

import { Field, FormMessage, SubmitButton } from './form-bits';

/**
 * Passwordless sign-in in two steps: the email, then the 6-digit code from
 * the email. The email is carried in the form, never in the URL.
 */
export function SignInForm({ next }: { next: string }) {
  const [state, action] = useActionState<SignInState, FormData>(signInAction, { status: 'idle', step: 'email' });
  const codeId = useId();
  const hintId = useId();
  const code = useRef<HTMLInputElement>(null);
  const onCodeStep = state.step === 'code';

  // Move to the code field when the code step opens, and after a wrong code.
  useEffect(() => {
    if (onCodeStep) code.current?.focus();
  }, [onCodeStep, state]);

  if (!onCodeStep) {
    return (
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <Field
          name="email"
          label="Email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          required
          maxLength={255}
          enterKeyHint="send"
          defaultValue={state.email ?? ''}
          error={state.fieldErrors?.email}
        />
        <FormMessage state={state} />
        <div>
          <SubmitButton pendingText="Sending…">Email me a sign-in code</SubmitButton>
        </div>
      </form>
    );
  }

  const codeError = state.fieldErrors?.code;
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={state.email ?? ''} />
        <div className="field">
          <label htmlFor={codeId}>Sign-in code</label>
          {/* The hint sits above the field so autofill popups and keyboards don't cover it. */}
          <p id={hintId} className="hint">
            Enter the 6-digit code we sent to {state.email}. It works for 15 minutes.
          </p>
          <input
            ref={code}
            id={codeId}
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            enterKeyHint="done"
            aria-describedby={codeError ? `${hintId} ${codeId}-error` : hintId}
            aria-invalid={codeError ? true : undefined}
            className="w-48 font-mono text-xl tracking-[0.35em]"
          />
          {codeError ? (
            <p id={`${codeId}-error`} className="field-error">
              {codeError}
            </p>
          ) : null}
        </div>
        <FormMessage state={state} />
        <div>
          <SubmitButton pendingText="Checking…">Sign in</SubmitButton>
        </div>
      </form>
      {/* Same action without a code: emails a new one. */}
      <form action={action}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="email" value={state.email ?? ''} />
        <SubmitButton className="text-sm font-medium underline underline-offset-4" pendingText="Sending…">
          Send a new code
        </SubmitButton>
      </form>
    </div>
  );
}
