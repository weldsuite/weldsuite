import type { WeldDesignTokens, WeldTheme } from './types';

/**
 * Suite tokens the host may set. Anything else in a `designTokens` payload is
 * ignored, so a host can never write arbitrary custom properties.
 */
export const DESIGN_TOKEN_NAMES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'radius',
] as const;

const TOKEN_NAME_SET: ReadonlySet<string> = new Set(DESIGN_TOKEN_NAMES);

/** Only Google Fonts stylesheets may be injected. */
const FONT_STYLESHEET_ORIGIN = 'https://fonts.googleapis.com';

const FONT_LINK_ATTR = 'data-weld-host-font';

/**
 * A CSS value safe to drop into a custom property: colours, lengths,
 * `oklch()`/`color-mix()` and font stacks. Rejects anything that could end
 * the declaration or pull in a resource (`;`, braces, `url(`, `@`, `<`).
 */
export function isSafeCssValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 200) return false;
  if (/[;{}<>@\\]/.test(value)) return false;
  if (/url\s*\(|expression\s*\(|image-set\s*\(/i.test(value)) return false;
  return /^[\w\s#%.,()'"/+\-*]+$/.test(value);
}

export function isAllowedFontStylesheet(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  try {
    const url = new URL(href);
    return url.origin === FONT_STYLESHEET_ORIGIN && url.pathname.startsWith('/css');
  } catch {
    return false;
  }
}

/** The `--wui-*` declarations a token payload maps to, after filtering. */
export function designTokenDeclarations(tokens: WeldDesignTokens | null | undefined): [string, string][] {
  if (!tokens || typeof tokens !== 'object') return [];
  const out: [string, string][] = [];
  const vars = tokens.vars && typeof tokens.vars === 'object' ? tokens.vars : {};
  for (const [name, value] of Object.entries(vars)) {
    if (TOKEN_NAME_SET.has(name) && isSafeCssValue(value)) {
      out.push([`--wui-${name}`, value]);
    }
  }
  if (isSafeCssValue(tokens.fontFamily)) {
    out.push(['--wui-font', tokens.fontFamily]);
  }
  return out;
}

/** Mirror the host theme on `<html>` (`data-theme`, `.dark`, `color-scheme`). */
export function applyTheme(theme: WeldTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Apply host design tokens as inline `--wui-*` properties on `<html>`. */
export function applyDesignTokens(tokens: WeldDesignTokens | null | undefined): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [property, value] of designTokenDeclarations(tokens)) {
    root.style.setProperty(property, value);
  }
  const href = tokens?.fontStylesheet;
  if (isAllowedFontStylesheet(href) && !document.querySelector(`link[${FONT_LINK_ATTR}]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute(FONT_LINK_ATTR, '');
    document.head.appendChild(link);
  }
}
