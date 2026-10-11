/**
 * Partner-supplied URLs (website, support page, logo) are shown to people who
 * did not enter them, so only plain http(s) addresses are ever rendered as
 * links or images. A `javascript:` or `data:` URL would pass a basic URL
 * validator.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
