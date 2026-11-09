/**
 * The embed markup of the "WeldForms form" block: the `data-wf*` attributes
 * `@weldsuite/forms-embed` reads (packages/sdk/forms-embed/src/auto.ts), and the
 * script URL that starts them.
 */

export const WELDFORMS_PORTAL_URL = 'https://forms.weldsuite.org';

export const WELDFORMS_EMBED_MODES = ['inline', 'popup', 'slider', 'popover', 'fullpage'] as const;
export type WeldFormsEmbedMode = (typeof WELDFORMS_EMBED_MODES)[number];

export interface WeldFormsHiddenField {
  key: string;
  value: string;
}

export interface WeldFormsEmbedInput {
  publicId?: string;
  embedMode?: string;
  height?: string | number;
  buttonText?: string;
  buttonColor?: string;
  hiddenFields?: WeldFormsHiddenField[];
  portalUrl?: string;
}

const HIDDEN_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function isEmbedMode(value: unknown): value is WeldFormsEmbedMode {
  return typeof value === 'string' && (WELDFORMS_EMBED_MODES as readonly string[]).includes(value);
}

/** An http(s) origin without a trailing slash; the default portal for anything else. */
export function normalizePortalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return WELDFORMS_PORTAL_URL;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return WELDFORMS_PORTAL_URL;
    return url.origin;
  } catch {
    return WELDFORMS_PORTAL_URL;
  }
}

export function embedScriptUrl(portalUrl: unknown): string {
  return `${normalizePortalUrl(portalUrl)}/embed.js`;
}

/** `a=1,b=2` for `data-wf-hidden`: keys the embed accepts, values without commas. */
export function hiddenAttribute(fields: unknown): string {
  if (!Array.isArray(fields)) return '';
  const parts: string[] = [];
  for (const field of fields as Array<Partial<WeldFormsHiddenField> | null>) {
    const key = typeof field?.key === 'string' ? field.key.trim() : '';
    if (!HIDDEN_KEY.test(key)) continue;
    const value = typeof field?.value === 'string' ? field.value.replace(/[,\r\n]/g, ' ').trim() : '';
    parts.push(`${key}=${value}`);
  }
  return parts.join(',');
}

/** `auto`, empty or invalid is no fixed height; a positive number is pixels. */
export function heightPixels(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/px$/, '');
  if (text === '' || text === 'auto') return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The public id when it looks like one; null otherwise (nothing is embedded). */
export function cleanPublicId(value: unknown): string | null {
  return typeof value === 'string' && PUBLIC_ID.test(value.trim()) ? value.trim() : null;
}

/** The `data-wf*` attributes for the block's element; null without a usable public id. */
export function embedAttributes(input: WeldFormsEmbedInput): Record<string, string> | null {
  const publicId = cleanPublicId(input.publicId);
  if (!publicId) return null;
  const mode: WeldFormsEmbedMode = isEmbedMode(input.embedMode) ? input.embedMode : 'inline';
  const attrs: Record<string, string> = { 'data-wf': publicId, 'data-wf-mode': mode };
  const portal = normalizePortalUrl(input.portalUrl);
  if (portal !== WELDFORMS_PORTAL_URL) attrs['data-wf-base-url'] = portal;
  const hidden = hiddenAttribute(input.hiddenFields);
  if (hidden) attrs['data-wf-hidden'] = hidden;
  const height = heightPixels(input.height);
  if (height !== null && mode !== 'slider' && mode !== 'fullpage') attrs['data-wf-height'] = String(height);
  if (mode === 'popover') {
    if (input.buttonText?.trim()) attrs['data-wf-button-text'] = input.buttonText.trim();
    if (input.buttonColor?.trim()) attrs['data-wf-button-color'] = input.buttonColor.trim();
  }
  return attrs;
}

/** Popup and slider embeds use the element itself as the trigger, so it renders as a button. */
export function usesElementAsTrigger(mode: unknown): boolean {
  return mode === 'popup' || mode === 'slider';
}

/**
 * What a site editor offers for the block: the settings and their defaults.
 * `publicId` is chosen from the workspace's published forms where the editor can
 * list them (`createWeldFormsApi(...).list({ status: 'published' })`, each row's
 * `publicId`), and typed by hand otherwise.
 */
export const WELDFORMS_FORM_BLOCK_TYPE = 'weldFormsForm';
export const WELDFORMS_FORM_BLOCK_DEFAULTS = {
  publicId: '',
  embedMode: 'inline',
  height: 'auto',
  buttonText: 'Open form',
  buttonColor: '#111827',
  hiddenFields: [] as WeldFormsHiddenField[],
  portalUrl: WELDFORMS_PORTAL_URL,
};
