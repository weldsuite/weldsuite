import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

import { text } from '../lib/messages';

/** What a route action answers with. */
export interface ActionState {
  ok: boolean;
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Checkout: send the same idempotency key again (the outcome is unknown). */
  keepKey?: boolean;
}

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name'> {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  /** Shows "(optional)"; the other fields are required. */
  optional?: boolean;
}

/** A labelled input, marked and described when the last answer named it. */
export function Field({ name, label, hint, error, optional = false, className, ...input }: Readonly<FieldProps>) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${className ?? ''}`}>
      <label htmlFor={id}>
        {label}
        {optional ? <span className="hint font-normal"> ({text.optional})</span> : null}
      </label>
      <input id={id} name={name} required={!optional} aria-invalid={error ? true : undefined} aria-describedby={described} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The answer of a form: a status after a success, an alert after a failure. */
export function FormMessage({ state }: Readonly<{ state: ActionState | undefined }>) {
  if (!state?.message) return null;
  return (
    <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'notice notice-success' : 'notice notice-danger'}>
      {state.message}
    </p>
  );
}

/** A submit button that says what is happening and can't be pressed twice. */
export function SubmitButton({ busy, busyText, children, className = 'btn btn-primary', ...rest }: Readonly<{ busy: boolean; busyText: string; children: ReactNode; className?: string; name?: string; value?: string }>) {
  return (
    <button type="submit" className={className} disabled={busy} {...rest}>
      {busy ? busyText : children}
    </button>
  );
}
