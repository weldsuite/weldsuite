'use client';

import {
  startTransition,
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { useFormStatus } from 'react-dom';

import type { FormState } from '@/lib/actions/state';

/**
 * A submit button that turns itself off while its form is being sent, so a
 * second click can't post twice.
 */
export function SubmitButton({
  children,
  pendingText,
  className = 'btn btn-primary',
}: {
  children: ReactNode;
  pendingText?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending && pendingText ? pendingText : children}
    </button>
  );
}

/**
 * The outcome of the last submit, in a live region that stays in the page
 * (a region that only appears when there is a message is not announced
 * reliably).
 */
export function FormMessage({ state }: { state: FormState }) {
  const tone =
    state.status === 'error'
      ? 'border-danger bg-danger-soft text-danger'
      : 'border-success bg-success-soft text-success';
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {state.message ? <p className={`rounded-lg border px-4 py-3 text-sm font-medium ${tone}`}>{state.message}</p> : null}
    </div>
  );
}

/**
 * After a refused submit, move focus to the first field the server marked
 * invalid, so its error is read out.
 */
export function useFocusFirstError(form: RefObject<HTMLFormElement | null>, state: FormState) {
  useEffect(() => {
    if (state.status !== 'error' || !state.fieldErrors) return;
    const first = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.focus();
  }, [form, state]);
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  /** Shown after the label for optional fields. */
  optional?: boolean;
};

/** A labelled input with its hint and error wired up for assistive tech. */
export function Field({ name, label, hint, error, optional, className = '', ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>
        {label}
        {optional ? <span className="hint font-normal"> (optional)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      <input id={id} name={name} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Submit a form to its action without React's automatic reset afterwards,
 * for forms whose choices should stay as they are (the variant picker, the
 * payment method). Without JavaScript the form's `action` still posts.
 */
export function submitKeepingValues(dispatch: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => dispatch(data));
  };
}

/** A submit button driven by an action's pending flag (for `submitKeepingValues` forms). */
export function PendingButton({
  pending,
  children,
  pendingText,
  className = 'btn btn-primary',
}: {
  pending: boolean;
  children: ReactNode;
  pendingText: string;
  className?: string;
}) {
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingText : children}
    </button>
  );
}

/** A ref for a form plus focus-on-error, in one line. */
export function useFormFocus(state: FormState) {
  const ref = useRef<HTMLFormElement>(null);
  useFocusFirstError(ref, state);
  return ref;
}
