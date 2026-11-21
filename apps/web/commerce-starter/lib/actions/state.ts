/** What a form's server action answers with (React's useActionState). */
export interface FormState {
  status: 'idle' | 'success' | 'error';
  message?: string;
  /** Field name → message, for the fields the API refused. */
  fieldErrors?: Record<string, string>;
}

export const idle: FormState = { status: 'idle' };

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A whole number between min and max, or null. */
export function wholeNumber(form: FormData, name: string, min: number, max: number): number | null {
  const raw = text(form, name);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** A same-site path to go to after signing in; anything else becomes `fallback`. */
export function safePath(value: string, fallback: string): string {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : fallback;
}
