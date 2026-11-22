/** A route segment as text (decoded once; left alone when it isn't valid percent-encoding). */
export function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** One query parameter as a string. */
export function single(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value) || undefined;
}
