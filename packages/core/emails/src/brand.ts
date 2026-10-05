import { theme } from './theme';

/** WeldSuite modules that send mail; used as the From display name. */
export type EmailModule =
  | 'WeldSuite'
  | 'WeldCalendar'
  | 'WeldMeet'
  | 'WeldFlow'
  | 'WeldChat'
  | 'WeldDesk'
  | 'WeldAgent'
  | 'WeldCommerce'
  | 'WeldHR';

/**
 * Who the email looks like it comes from.
 *
 * - `weldsuite`: mail to workspace members. WeldSuite logo, module as sender name.
 * - `workspace`: mail to people outside the workspace (booking guests, portal
 *   users). The workspace's logo and accent color, and a small "Sent via
 *   WeldSuite" footer.
 */
export type EmailBrand =
  | { kind: 'weldsuite'; module?: EmailModule }
  | {
      kind: 'workspace';
      name: string;
      logoUrl?: string | null;
      accentColor?: string | null;
    };

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The accent color of a brand. Workspace colors come from settings, so anything
 * that is not a plain hex color falls back to the theme accent: the value lands
 * in inline styles, where it must not be able to carry other CSS.
 */
export function accentOf(brand: EmailBrand): string {
  if (brand.kind === 'workspace' && brand.accentColor && HEX_COLOR.test(brand.accentColor.trim())) {
    return brand.accentColor.trim();
  }
  return theme.color.accent;
}

/** An https logo URL, or undefined (http images are blocked by most clients). */
export function logoUrlOf(brand: EmailBrand): string | undefined {
  if (brand.kind !== 'workspace' || !brand.logoUrl) return undefined;
  try {
    const url = new URL(brand.logoUrl);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Display name used in the From header when the caller does not set one. */
export function senderNameOf(brand: EmailBrand): string {
  if (brand.kind === 'workspace') return brand.name;
  return brand.module ?? 'WeldSuite';
}
