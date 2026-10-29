/**
 * Project tokens. `wpk_` + 32 hex characters: public, safe in page source,
 * and only able to send data to the project (ADR PANEL-001).
 */

export const PROJECT_TOKEN_PREFIX = 'wpk_';
export const PROJECT_TOKEN_PATTERN = /^wpk_[0-9a-f]{32}$/;

export function generateProjectToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return PROJECT_TOKEN_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isProjectToken(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_TOKEN_PATTERN.test(value);
}
