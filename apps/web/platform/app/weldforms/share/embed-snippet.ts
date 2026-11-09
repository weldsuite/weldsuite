/**
 * The share tab's pure helpers: the embed configuration, the snippet a site
 * owner pastes, the URL the live preview loads and the prefill / hidden-field
 * URL builder.
 *
 * The attribute names live in `EMBED_ATTRS` and the query parameters in
 * `buildEmbedQuery`, in one place, because `@weldsuite/forms-embed` and
 * forms-portal's embed view must agree with them (the SDK, the portal and this
 * configurator change in lockstep, like the helpdesk widget).
 */

export const EMBED_MODES = ['inline', 'popup', 'slider', 'popover', 'fullpage'] as const;
export type EmbedMode = (typeof EMBED_MODES)[number];

export const EMBED_SIZES = ['small', 'medium', 'large'] as const;
export type EmbedSize = (typeof EMBED_SIZES)[number];

/** When a popup or slider opens by itself; `click` waits for the visitor. */
export const EMBED_TRIGGERS = ['click', 'load', 'exit', 'scroll'] as const;
export type EmbedTrigger = (typeof EMBED_TRIGGERS)[number];

export interface HiddenFieldValue {
  name: string;
  value: string;
}

export interface EmbedConfig {
  mode: EmbedMode;
  size: EmbedSize;
  buttonText: string;
  /** `#rrggbb`. */
  buttonColor: string;
  hidden: HiddenFieldValue[];
  /** Inline: grow with the form instead of a fixed height. */
  autoHeight: boolean;
  /** Inline with `autoHeight` off, in pixels. */
  height: number;
  trigger: EmbedTrigger;
  /** Scroll depth in percent, for the `scroll` trigger. */
  scrollPercent: number;
  hideAfterSubmit: boolean;
}

export const DEFAULT_EMBED_CONFIG: EmbedConfig = {
  mode: 'inline',
  size: 'medium',
  buttonText: 'Open the form',
  buttonColor: '#2563eb',
  hidden: [],
  autoHeight: true,
  height: 600,
  trigger: 'click',
  scrollPercent: 50,
  hideAfterSubmit: false,
};

export const EMBED_ATTRS = {
  form: 'data-wf',
  mode: 'data-wf-mode',
  hidden: 'data-wf-hidden',
  size: 'data-wf-size',
  buttonColor: 'data-wf-button-color',
  open: 'data-wf-open',
  height: 'data-wf-height',
  hideAfterSubmit: 'data-wf-hide-after-submit',
} as const;

/** Modes that open on top of the page and so have a trigger. */
export function hasTrigger(mode: EmbedMode): boolean {
  return mode === 'popup' || mode === 'slider';
}

/** Whether the snippet renders a button the visitor clicks. */
export function hasButton(config: Pick<EmbedConfig, 'mode' | 'trigger'>): boolean {
  if (config.mode === 'popover') return true;
  return hasTrigger(config.mode) && config.trigger === 'click';
}

export function hasSize(mode: EmbedMode): boolean {
  return mode === 'popup' || mode === 'slider';
}

/** `https://forms.weldsuite.org/f/abc` gives `https://forms.weldsuite.org`; null for anything that is not a URL. */
export function portalOrigin(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return null;
  }
}

export function embedScriptUrl(origin: string): string {
  return `${origin}/embed.js`;
}

const HIDDEN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Entries with a valid, unique name; a value may be empty. */
export function cleanHidden(entries: readonly HiddenFieldValue[]): HiddenFieldValue[] {
  const seen = new Set<string>();
  const out: HiddenFieldValue[] = [];
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!HIDDEN_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: entry.value });
  }
  return out;
}

function encodeEntries(entries: readonly HiddenFieldValue[]): string {
  const params = new URLSearchParams();
  for (const { name, value } of cleanHidden(entries)) params.append(name, value);
  return params.toString();
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/** The value of `data-wf-open`: `click`, `load`, `exit` or `scroll:50`. */
export function openAttribute(config: Pick<EmbedConfig, 'trigger' | 'scrollPercent'>): string {
  if (config.trigger === 'scroll') return `scroll:${clampPercent(config.scrollPercent)}`;
  return config.trigger;
}

/**
 * The query the portal's embed view reads (`/f/<publicId>?embed=<mode>&...`):
 * the mode, then the hidden fields as plain `name=value` pairs, the same way a
 * prefill link carries them.
 */
export function buildEmbedQuery(config: EmbedConfig): string {
  const params = new URLSearchParams();
  params.set('embed', config.mode);
  for (const { name, value } of cleanHidden(config.hidden)) params.append(name, value);
  return params.toString();
}

/** What the live preview iframe loads. */
export function buildEmbedUrl(origin: string, publicId: string, config: EmbedConfig): string {
  return `${origin}/f/${encodeURIComponent(publicId)}?${buildEmbedQuery(config)}`;
}

/** The markup and script tag the site owner pastes. */
export function buildEmbedSnippet(origin: string, publicId: string, config: EmbedConfig): string {
  const attrs: Array<[string, string]> = [
    [EMBED_ATTRS.form, publicId],
    [EMBED_ATTRS.mode, config.mode],
  ];

  const hidden = encodeEntries(config.hidden);
  if (hidden) attrs.push([EMBED_ATTRS.hidden, hidden]);

  if (config.mode === 'inline') {
    attrs.push([EMBED_ATTRS.height, config.autoHeight ? 'auto' : String(Math.max(200, Math.round(config.height)))]);
  }
  if (hasSize(config.mode)) attrs.push([EMBED_ATTRS.size, config.size]);
  if (hasTrigger(config.mode)) attrs.push([EMBED_ATTRS.open, openAttribute(config)]);
  if (config.mode === 'popover' && isHexColor(config.buttonColor)) {
    attrs.push([EMBED_ATTRS.buttonColor, config.buttonColor]);
  }
  if (config.hideAfterSubmit) attrs.push([EMBED_ATTRS.hideAfterSubmit, 'true']);

  const attrText = attrs.map(([name, value]) => `${name}="${escapeAttr(value)}"`).join(' ');
  const script = `<script async src="${escapeAttr(embedScriptUrl(origin))}"></script>`;

  if (config.mode === 'popover') {
    return `<div ${attrText}>${escapeText(config.buttonText)}</div>\n${script}`;
  }
  if (hasButton(config)) {
    const style = isHexColor(config.buttonColor)
      ? ` style="background:${config.buttonColor};color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer"`
      : '';
    return `<button type="button" ${attrText}${style}>${escapeText(config.buttonText)}</button>\n${script}`;
  }
  return `<div ${attrText}></div>\n${script}`;
}

/** A link that prefills fields and hidden fields: `<link>?name=value&...`. Fields are addressed by their ref. */
export function buildPrefillUrl(publicUrl: string, entries: readonly HiddenFieldValue[]): string {
  const query = encodeEntries(entries);
  if (!query) return publicUrl;
  return `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}${query}`;
}

/** What a QR code points at: the public link tagged with its source. */
export function qrTarget(publicUrl: string): string {
  return buildPrefillUrl(publicUrl, [{ name: 'source', value: 'qr' }]);
}
